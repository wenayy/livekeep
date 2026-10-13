import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../extension/lib/db.js';
import { pumpPart, pumpAll, ALIGN, MAX_REQUEST } from '../extension/lib/uploader.js';

// A fake Drive that enforces the resumable-upload rules the real one does.
class FakeDrive {
  constructor() {
    this.sessions = new Map();
    this.files = new Map();
    this.validTokens = new Set(['good']);
    this.requests = [];
    this.acceptLimit = null; // simulate Drive persisting fewer bytes than sent
    this.nextId = 1;
  }

  fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    this.requests.push({ url, method: init.method, range: headers['Content-Range'] });
    const token = headers.Authorization?.replace('Bearer ', '');
    if (!this.validTokens.has(token)) return new Response('{"error":{"errors":[{"reason":"authError"}]}}', { status: 401 });

    if (init.method === 'POST' && url.includes('uploadType=resumable')) {
      const meta = JSON.parse(init.body);
      const uri = `https://upload.test/session/${this.nextId++}`;
      this.sessions.set(uri, { meta, bytes: new Uint8Array(0) });
      return new Response('', { status: 200, headers: { Location: uri } });
    }

    if (init.method === 'PUT') {
      const session = this.sessions.get(url);
      if (!session) return new Response('{"error":{"errors":[{"reason":"notFound"}]}}', { status: 404 });
      const body = new Uint8Array(await init.body.arrayBuffer());
      const m = headers['Content-Range'].match(/^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/);
      assert.ok(m, `bad Content-Range ${headers['Content-Range']}`);
      const total = m[3] === '*' ? null : Number(m[3]);
      if (m[1] !== undefined) {
        const start = Number(m[1]);
        assert.equal(Number(m[2]) - start + 1, body.length, 'range length matches body');
        assert.equal(start, session.bytes.length, 'upload resumes exactly where Drive left off');
        if (total === null) assert.equal(body.length % ALIGN, 0, 'non-final pieces are 256 KiB multiples');
        let take = body;
        if (this.acceptLimit !== null && total === null) {
          take = body.subarray(0, Math.min(body.length, this.acceptLimit));
          this.acceptLimit = null;
        }
        const merged = new Uint8Array(session.bytes.length + take.length);
        merged.set(session.bytes);
        merged.set(take, session.bytes.length);
        session.bytes = merged;
      } else {
        assert.equal(body.length, 0);
      }
      if (total !== null && session.bytes.length === total) {
        const id = `file-${this.nextId++}`;
        this.files.set(id, { ...session.meta, bytes: session.bytes });
        this.sessions.delete(url);
        return Response.json({ id }, { status: 200 });
      }
      const headersOut = session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {};
      return new Response('', { status: 308, headers: headersOut });
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
}

let drive;
let tokenCalls;
const getToken = async (stale) => {
  tokenCalls.push(stale ?? null);
  return stale ? 'good' : drive.currentToken;
};

beforeEach(() => {
  drive = new FakeDrive();
  drive.currentToken = 'good';
  tokenCalls = [];
  globalThis.fetch = drive.fetch;
});

let seq = 0;
async function newPart(extra = {}) {
  const id = `rec-test-${++seq}:0000`;
  await db.putPart({
    id, recordingId: `rec-test-${seq}`, index: 0, name: `part ${seq}.mp4`, mimeType: 'video/mp4', folderId: 'folder',
    written: 0, uploaded: 0, closed: false, done: false, failed: false, sessionUri: null, fileId: null, ...extra,
  });
  return id;
}

function bytes(n, seed) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function append(partId, arr) {
  await db.appendChunk(partId, arr.slice().buffer);
}

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

test('uploads aligned bytes while recording, keeps only the tail locally, then finalizes', async () => {
  const id = await newPart();
  const a = bytes(600_000, 1);
  for (let off = 0; off < a.length; off += 200_000) await append(id, a.subarray(off, off + 200_000));
  await pumpPart(id, { getToken });

  let part = await db.getPart(id);
  assert.equal(part.uploaded, 2 * ALIGN, 'only whole 256 KiB blocks go up mid-recording');
  assert.equal(part.done, false);
  await assert.rejects(db.readRange(id, 0, 1), /Local data missing/, 'fully uploaded chunks are freed');
  assert.equal((await db.readRange(id, 400_000, 600_000)).size, 200_000, 'the chunk holding the unsent tail is kept');

  const b = bytes(300_000, 2);
  await append(id, b);
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });

  part = await db.getPart(id);
  assert.equal(part.done, true);
  const file = drive.files.get(part.fileId);
  assert.equal(file.name, part.name);
  assert.deepEqual(file.bytes, concat(a, b), 'Drive file is byte-identical to what was recorded');
});

test('finalizes with an empty request when everything is already uploaded', async () => {
  const id = await newPart();
  const a = bytes(ALIGN * 3, 3);
  await append(id, a);
  await pumpPart(id, { getToken });
  assert.equal((await db.getPart(id)).uploaded, ALIGN * 3);

  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.equal(drive.requests.at(-1).range, `bytes */${ALIGN * 3}`);
  assert.deepEqual(drive.files.get(part.fileId).bytes, a);
});

test('resends from where Drive actually stopped when it stores fewer bytes', async () => {
  const id = await newPart();
  const a = bytes(ALIGN * 4 + 1000, 4);
  await append(id, a);
  drive.acceptLimit = ALIGN; // Drive keeps only the first block of the first PUT
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.deepEqual(drive.files.get(part.fileId).bytes, a);
});

test('refreshes an expired token and carries on', async () => {
  const id = await newPart();
  drive.currentToken = 'expired';
  await append(id, bytes(ALIGN, 5));
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  assert.equal((await db.getPart(id)).done, true);
  assert.ok(tokenCalls.includes('expired'), 'stale token handed back for invalidation');
});

test('splits a large backlog (e.g. after being offline) into bounded requests', async () => {
  const id = await newPart();
  const pieces = [];
  for (let i = 0; i < 20; i++) { const p = bytes(1_000_000, i); pieces.push(p); await append(id, p); }
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.deepEqual(drive.files.get(part.fileId).bytes, concat(...pieces));
  const puts = drive.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, Math.ceil(20_000_000 / MAX_REQUEST));
});

test('resumes an interrupted upload session after a restart', async () => {
  const id = await newPart();
  const a = bytes(ALIGN * 2 + 500, 6);
  await append(id, a);
  await pumpPart(id, { getToken }); // two blocks up, session open
  const before = await db.getPart(id);
  assert.ok(before.sessionUri);

  // "Browser restart": recorder is gone, part gets closed by the recovery step.
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpAll({ getToken });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.equal(part.sessionUri, before.sessionUri, 'same Drive session was resumed');
  assert.deepEqual(drive.files.get(part.fileId).bytes, a);
});

test('marks a part failed when its upload session has expired', async () => {
  const id = await newPart();
  await append(id, bytes(ALIGN * 2, 7));
  await pumpPart(id, { getToken });
  drive.sessions.clear();
  await append(id, bytes(100, 8));
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  const part = await db.getPart(id);
  assert.equal(part.failed, true);
  assert.equal(part.done, false);
});

test('drops parts that closed without any data', async () => {
  const id = await newPart({ closed: true });
  await pumpPart(id, { getToken });
  assert.equal(await db.getPart(id), undefined);
  assert.equal(drive.requests.length, 0);
});

test('nothing is sent while less than one aligned block is pending', async () => {
  const id = await newPart();
  await append(id, bytes(ALIGN - 1, 9));
  await pumpPart(id, { getToken });
  assert.equal(drive.requests.length, 0);
  assert.equal((await db.getPart(id)).uploaded, 0);
});

test('saves a local part as one file only once it is complete', async () => {
  const saved = [];
  const saveLocal = async (part, blob) => { saved.push({ name: part.name, bytes: new Uint8Array(await blob.arrayBuffer()) }); return 'download-1'; };
  const id = await newPart({ destination: 'local', localDir: 'LiveKeep Recordings/x' });
  const a = bytes(ALIGN * 3, 10);
  await append(id, a);
  await pumpPart(id, { getToken, saveLocal });
  assert.equal(saved.length, 0, 'nothing written while the part is still recording');
  assert.equal(drive.requests.length, 0, 'local parts never touch Drive');

  const b = bytes(1234, 11);
  await append(id, b);
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken, saveLocal });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.equal(part.uploaded, part.written);
  assert.deepEqual(saved[0].bytes, concat(a, b));
  await assert.rejects(db.readRange(id, 0, 1), /Local data missing/, 'local buffer freed after saving');
});

test('a failing Drive part does not block a local part', async () => {
  const saved = [];
  const saveLocal = async (part) => { saved.push(part.id); return 'download-2'; };
  const driveId = await newPart({ closed: true });
  await append(driveId, bytes(100, 12));
  const localId = await newPart({ destination: 'local', closed: true });
  await append(localId, bytes(100, 13));
  drive.validTokens.clear(); // signed out
  await assert.rejects(pumpAll({ getToken, saveLocal }));
  assert.ok(saved.includes(localId));
  assert.equal((await db.getPart(driveId)).done, false, 'Drive part waits for sign-in, data kept');
  assert.equal((await db.readRange(driveId, 0, 100)).size, 100);
});

test('Blob chunks (how Chrome stores them) upload byte-for-byte', async () => {
  const id = await newPart();
  const pieces = [bytes(200_000, 20), bytes(300_000, 21), bytes(123_456, 22)];
  for (const p of pieces) await db.appendChunk(id, new Blob([p]));
  await pumpPart(id, { getToken }); // aligned prefix mid-recording
  await db.updatePart(id, (p) => { p.closed = true; });
  await pumpPart(id, { getToken });
  const part = await db.getPart(id);
  assert.equal(part.done, true);
  assert.deepEqual(drive.files.get(part.fileId).bytes, concat(...pieces));
});
