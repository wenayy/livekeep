// IndexedDB is the source of truth for recorded bytes that haven't been saved yet.
// The recorder appends chunks, the uploader drains them, and anything left after a
// crash or browser restart is picked up again on the next launch.
//
// parts:  { id, recordingId, index, name, mimeType, folderId,
//           written, uploaded, closed, done, failed, error, sessionUri, fileId, createdAt }
// chunks: { partId, offset, data: Blob }   keyed by [partId, offset]
//
// Chunks are stored as Blobs, which Chrome keeps on disk, so even a multi-hour
// single-file recording is assembled and saved without loading it into memory.

const DB_NAME = 'livekeep';
let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('parts', { keyPath: 'id' });
        db.createObjectStore('chunks', { keyPath: ['partId', 'offset'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Runs fn inside one transaction and resolves when it commits. fn must issue its
// requests synchronously or from request callbacks so the transaction stays alive.
async function run(stores, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const committed = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const result = { value: undefined };
  fn(tx, result);
  await committed;
  return result.value;
}

const chunkRange = (partId) => IDBKeyRange.bound([partId, 0], [partId, Infinity]);
const sizeOf = (data) => data.size ?? data.byteLength;

export function putPart(part) {
  return run(['parts'], 'readwrite', (tx) => tx.objectStore('parts').put(part));
}

export function getPart(id) {
  return run(['parts'], 'readonly', (tx, out) => {
    tx.objectStore('parts').get(id).onsuccess = (e) => { out.value = e.target.result; };
  });
}

export function allParts() {
  return run(['parts'], 'readonly', (tx, out) => {
    tx.objectStore('parts').getAll().onsuccess = (e) => { out.value = e.target.result; };
  });
}

// Atomic read-modify-write; returns the updated part (undefined if it doesn't exist).
export function updatePart(id, mutate) {
  return run(['parts'], 'readwrite', (tx, out) => {
    const store = tx.objectStore('parts');
    store.get(id).onsuccess = (e) => {
      const part = e.target.result;
      if (!part) return;
      mutate(part);
      store.put(part);
      out.value = part;
    };
  });
}

// Appends at the part's current end, so callers never track offsets themselves.
export function appendChunk(partId, data) {
  return run(['parts', 'chunks'], 'readwrite', (tx) => {
    const parts = tx.objectStore('parts');
    parts.get(partId).onsuccess = (e) => {
      const part = e.target.result;
      if (!part) return;
      tx.objectStore('chunks').put({ partId, offset: part.written, data });
      part.written += sizeOf(data);
      parts.put(part);
    };
  });
}

// Returns bytes [start, end) of a part as a Blob, reading only the chunks it needs.
export async function readRange(partId, start, end) {
  const pieces = [];
  let covered = 0;
  await run(['chunks'], 'readonly', (tx) => {
    tx.objectStore('chunks').openCursor(chunkRange(partId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const { offset, data } = cursor.value;
      if (offset >= end) return;
      const from = Math.max(start, offset);
      const to = Math.min(end, offset + sizeOf(data));
      if (to > from) {
        pieces.push(data instanceof Blob
          ? data.slice(from - offset, to - offset)
          : new Uint8Array(data, from - offset, to - from));
        covered += to - from;
      }
      cursor.continue();
    };
  });
  if (covered !== end - start) {
    throw new Error(`Local data missing for ${partId} [${start}, ${end})`);
  }
  return new Blob(pieces);
}

// Frees chunks that lie entirely below `offset` (i.e. confirmed as uploaded).
export function dropChunksBefore(partId, offset) {
  return run(['chunks'], 'readwrite', (tx) => {
    tx.objectStore('chunks').openCursor(chunkRange(partId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const { offset: chunkOffset, data } = cursor.value;
      if (chunkOffset + sizeOf(data) > offset) return;
      cursor.delete();
      cursor.continue();
    };
  });
}

export function dropAllChunks(partId) {
  return run(['chunks'], 'readwrite', (tx) => tx.objectStore('chunks').delete(chunkRange(partId)));
}

export function deleteParts(ids) {
  return run(['parts', 'chunks'], 'readwrite', (tx) => {
    for (const id of ids) {
      tx.objectStore('parts').delete(id);
      tx.objectStore('chunks').delete(chunkRange(id));
    }
  });
}
