// Drains recorded chunks from IndexedDB to where the user chose to save them.
// Drive: each part becomes one file, uploaded as bytes arrive (in 256 KiB multiples,
// as Drive requires for non-final pieces) and finalized once the part is closed.
// This computer: each part is written as one file once it is complete; until then
// its bytes wait in IndexedDB, which survives crashes and restarts.

import * as db from './db.js';
import * as drive from './drive.js';

export const ALIGN = 256 * 1024;
export const MAX_REQUEST = 32 * ALIGN; // 8 MiB per PUT

// getToken(staleToken?) -> access token; called again with the rejected token on 401.
async function withToken(getToken, fn) {
  const token = await getToken();
  try {
    return await fn(token);
  } catch (e) {
    if (e.status !== 401) throw e;
    return fn(await getToken(token));
  }
}

// sinks: { getToken(staleToken?) -> token, saveLocal(part, blob) -> file id }
export async function pumpPart(partId, sinks) {
  let part = await db.getPart(partId);
  if (!part || part.done || part.failed) return;

  if (part.closed && part.written === 0) {
    await db.deleteParts([partId]);
    return;
  }

  if (part.destination === 'local') {
    if (!part.closed) return;
    const blob = await db.readRange(partId, 0, part.written);
    const fileId = await sinks.saveLocal(part, blob);
    await db.updatePart(partId, (p) => { p.uploaded = p.written; p.done = true; p.fileId = fileId; });
    await db.dropAllChunks(partId);
    return;
  }

  const { getToken } = sinks;

  while (true) {
    const pending = part.written - part.uploaded;
    const sendable = part.closed ? pending : pending - (pending % ALIGN);
    if (sendable === 0 && !part.closed) return;

    const length = Math.min(sendable, MAX_REQUEST);
    const isLast = part.closed && length === pending;

    if (!part.sessionUri) {
      const sessionUri = await withToken(getToken, (token) =>
        drive.createUploadSession(token, { name: part.name, mimeType: part.mimeType, folderId: part.folderId }));
      part = await db.updatePart(partId, (p) => { p.sessionUri = sessionUri; });
    }

    const body = await db.readRange(partId, part.uploaded, part.uploaded + length);
    let result;
    try {
      result = await withToken(getToken, (token) =>
        drive.putChunk(token, part.sessionUri, body, part.uploaded, isLast ? part.written : null));
    } catch (e) {
      if (e.status === 404 || e.status === 410) {
        // The upload session expired (they last about a week); what Drive held is gone.
        await db.updatePart(partId, (p) => { p.failed = true; p.error = 'Upload session expired'; });
        await db.dropAllChunks(partId);
        return;
      }
      throw e;
    }

    if (result.done) {
      await db.updatePart(partId, (p) => { p.uploaded = p.written; p.done = true; p.fileId = result.file.id; });
      await db.dropAllChunks(partId);
      return;
    }

    if (result.received <= part.uploaded) {
      throw new Error('Drive accepted no new bytes; will retry');
    }
    part = await db.updatePart(partId, (p) => { p.uploaded = result.received; });
    await db.dropChunksBefore(partId, part.uploaded);
  }
}

// Saves everything that can be saved right now, oldest part first. One failing
// part (say, Drive while signed out) doesn't hold back the others.
export async function pumpAll(sinks) {
  const parts = (await db.allParts())
    .filter((p) => !p.done && !p.failed)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  let firstError = null;
  for (const part of parts) {
    try {
      await pumpPart(part.id, sinks);
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
}
