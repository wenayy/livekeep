// Minimal Google Drive v3 client. Uses the drive.file scope, so it only ever sees
// files and folders this extension created.

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

export class DriveError extends Error {
  constructor(status, body) {
    let reason = '';
    try { reason = JSON.parse(body).error?.errors?.[0]?.reason ?? ''; } catch {}
    const known = {
      accessNotConfigured: 'The Google Drive API is turned off for this app’s Google Cloud project. Enable it under APIs & Services → Library → Google Drive API.',
      storageQuotaExceeded: 'Your Google Drive is full.',
    };
    super(known[reason] ?? `Google Drive error ${status}${reason ? ` (${reason})` : ''}`);
    this.status = status;
    this.reason = reason;
  }
}

async function check(res) {
  if (!res.ok) throw new DriveError(res.status, await res.text());
  return res;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const quote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export async function getUser(token) {
  const res = await check(await fetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)', {
    headers: auth(token),
  }));
  const { user } = await res.json();
  return { name: user.displayName, email: user.emailAddress, photo: user.photoLink ?? null };
}

export const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

export async function createFolder(token, name, parentId = 'root', description = '') {
  const res = await check(await fetch(`${API}?fields=id`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId], description }),
  }));
  return (await res.json()).id;
}

// Returns the id of the top-level folder, reusing `cachedId` if it still exists.
export async function ensureRootFolder(token, name, cachedId) {
  if (cachedId) {
    const res = await fetch(`${API}/${cachedId}?fields=id,trashed`, { headers: auth(token) });
    if (res.ok && !(await res.json()).trashed) return cachedId;
  }
  const q = `name = ${quote(name)} and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`;
  const res = await check(await fetch(`${API}?fields=files(id)&q=${encodeURIComponent(q)}`, { headers: auth(token) }));
  const existing = (await res.json()).files?.[0]?.id;
  return existing ?? createFolder(token, name);
}

// Starts a resumable upload and returns its session URI (valid for about a week).
export async function createUploadSession(token, { name, mimeType, folderId }) {
  const res = await check(await fetch(`${UPLOAD}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      ...auth(token),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
    },
    body: JSON.stringify({ name, mimeType, parents: [folderId] }),
  }));
  const uri = res.headers.get('Location');
  if (!uri) throw new Error('Drive did not return an upload session');
  return uri;
}

// Sends `body` starting at byte `start`. Pass `total` only with the final piece
// (an empty body with `total` finalizes an upload whose bytes are all sent).
// Returns { done: true, file } or { done: false, received } where `received`
// is how many bytes Drive has durably stored.
export async function putChunk(token, sessionUri, body, start, total = null) {
  const range = body.size === 0
    ? `bytes */${total ?? '*'}`
    : `bytes ${start}-${start + body.size - 1}/${total ?? '*'}`;
  const res = await fetch(sessionUri, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Range': range },
    body,
  });
  if (res.status === 200 || res.status === 201) return { done: true, file: await res.json() };
  if (res.status === 308) {
    const header = res.headers.get('Range');
    return { done: false, received: header ? Number(header.split('-')[1]) + 1 : 0 };
  }
  throw new DriveError(res.status, await res.text());
}
