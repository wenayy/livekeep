// Runs in the offscreen document: owns the tab-capture streams, the MediaRecorders
// and the upload loop. Everything recorded lands in IndexedDB first, so a crash
// here loses at most the in-flight second of video.

import * as db from './lib/db.js';
import { pumpAll } from './lib/uploader.js';
import { QUALITY } from './lib/settings.js';
import { VideoCropper } from './lib/cropper.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const TIMESLICE_MS = 1000;
const IDLE_POLL_MS = 5000;
const KICK_BYTES = 2 * 1024 * 1024;

const recorders = new Map(); // recordingId -> TabRecorder
let pageBytes = 0; // bytes received from page recorders since the last upload kick
let lastError = null;

// One-file recordings are named after the stream; split ones (or a recorder restart) get part numbers.
function partName(fileBase, index, split, ext) {
  return split || index > 0
    ? `${fileBase} - part ${String(index + 1).padStart(3, '0')}.${ext}`
    : `${fileBase}.${ext}`;
}

const partId = (recordingId, index) => `${recordingId}:${String(index).padStart(4, '0')}`;

function pickMimeType() {
  const mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) throw new Error('This browser cannot record video');
  return mimeType;
}

class TabRecorder {
  constructor(recording, stream, settings, region) {
    this.rec = recording;
    this.stream = stream;
    this.quality = QUALITY[settings.quality];
    // Record only the video (cropped out of the tab), plus the tab's audio.
    this.cropper = new VideoCropper(stream.getVideoTracks()[0], this.quality.width, this.quality.height);
    this.cropper.setRegion(region);
    this.recordStream = new MediaStream([this.cropper.track, ...stream.getAudioTracks()]);
    this.partMs = settings.partMinutes * 60_000; // 0: one file for the whole recording
    this.mimeType = pickMimeType();
    this.container = this.mimeType.split(';')[0];
    this.ext = this.container === 'video/mp4' ? 'mp4' : 'webm';
    this.nextIndex = 0;
    this.stopping = false;
    this.bytesSinceKick = 0;

    // Tab capture silences the tab for the viewer, so route the audio back to the speakers.
    // The gain node only affects what you hear, never what gets recorded.
    this.audioCtx = new AudioContext();
    this.gain = this.audioCtx.createGain();
    this.audioCtx.createMediaStreamSource(stream).connect(this.gain).connect(this.audioCtx.destination);
    this.audioCtx.resume().catch(() => {});

    stream.getVideoTracks()[0].addEventListener('ended', () => {
      this.stop().then(() => notify({ type: 'captureEnded', recordingId: this.rec.id }));
    });
  }

  async start() {
    await this.startPart();
    this.scheduleRotation();
  }

  scheduleRotation() {
    clearTimeout(this.rotateTimer);
    if (!this.partMs) return;
    this.rotateTimer = setTimeout(() => this.rotate().catch(reportError), this.partMs);
  }

  // Each part is its own MediaRecorder, so every Drive file has its own header and plays on its own.
  async startPart() {
    const index = this.nextIndex++;
    const id = partId(this.rec.id, index);
    let chain = db.putPart({
      id,
      recordingId: this.rec.id,
      index,
      name: partName(this.rec.fileBase, index, !!this.partMs, this.ext),
      mimeType: this.container,
      destination: this.rec.destination,
      folderId: this.rec.folderId,
      localDir: this.rec.localDir,
      written: 0,
      uploaded: 0,
      closed: false,
      done: false,
      failed: false,
      sessionUri: null,
      fileId: null,
      createdAt: Date.now(),
    });

    const recorder = new MediaRecorder(this.recordStream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: this.quality.videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
      // MP4 data is only handed over at keyframes; a steady keyframe every 2 s keeps
      // bytes flowing into the crash-safe buffer even when the picture is still.
      videoKeyFrameIntervalDuration: 2000,
    });
    const stopped = new Promise((resolve) => {
      recorder.onstop = () => {
        chain = chain
          .then(() => db.updatePart(id, (p) => { p.closed = true; }))
          .catch(reportError)
          .then(() => { kickUploads(); resolve(); });
      };
    });
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      chain = chain
        .then(() => db.appendChunk(id, data))
        .catch(reportError);
      this.bytesSinceKick += data.size;
      if (this.bytesSinceKick >= KICK_BYTES) {
        this.bytesSinceKick = 0;
        kickUploads();
      }
    };
    recorder.onerror = (e) => {
      reportError(e.error ?? new Error('Recorder error'));
      if (!this.stopping && this.recorder === recorder) this.rotate().catch(reportError);
    };

    await chain;
    // Don't hang if Chrome never reports the start (it should within a moment).
    await new Promise((resolve) => {
      recorder.onstart = resolve;
      recorder.start(TIMESLICE_MS);
      setTimeout(resolve, 3000);
    });
    this.recorder = recorder;
    this.stopped = stopped;
  }

  // Start the next part before stopping the current one so there is no gap between files.
  async rotate() {
    if (this.stopping) return;
    const previous = this.recorder;
    await this.startPart();
    if (previous.state !== 'inactive') previous.stop();
    this.scheduleRotation();
  }

  async stop() {
    if (this.stopping) return this.stopped;
    this.stopping = true;
    clearTimeout(this.rotateTimer);
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    await this.stopped;
    this.stream.getTracks().forEach((t) => t.stop());
    this.cropper.stop();
    await this.audioCtx.close().catch(() => {});
    recorders.delete(this.rec.id);
    report().catch(reportError);
  }

  setMuted(muted) {
    this.gain.gain.value = muted ? 0 : 1;
  }
}

async function startRecording({ recording, streamId, settings, region }) {
  await ready;
  if (recorders.has(recording.id)) return;
  const q = QUALITY[settings.quality];
  // Capture the tab at up to twice the output size (keeping its aspect ratio) so the
  // video, which is only part of the tab, still has enough pixels once cropped.
  // The cropper always outputs q.width x q.height, so resizing never changes the encoding.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: Math.min(q.width * 2, 3840),
        maxHeight: Math.min(q.height * 2, 2160),
        maxFrameRate: q.frameRate,
      },
    },
  });
  const recorder = new TabRecorder(recording, stream, settings, region);
  recorders.set(recording.id, recorder);
  try {
    await recorder.start();
  } catch (e) {
    recorders.delete(recording.id);
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  report().catch(reportError);
}

// ---- Upload loop -------------------------------------------------------------

let wake = null;
let backoffMs = 0;

function kickUploads() {
  if (backoffMs === 0) wake?.();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
}

async function getToken(stale) {
  const res = await chrome.runtime.sendMessage({ to: 'sw', type: 'getToken', stale });
  if (!res?.ok) throw new Error(res?.error || 'Not signed in to Google');
  return res.token;
}

// Hands a finished part to the service worker, which writes it via chrome.downloads.
async function saveLocal(part, blob) {
  const url = URL.createObjectURL(new Blob([blob], { type: part.mimeType }));
  try {
    const res = await chrome.runtime.sendMessage({
      to: 'sw', type: 'download', url, filename: `${part.localDir}/${part.name}`, recordingId: part.recordingId,
    });
    if (!res?.ok) throw new Error(res?.error || 'Could not save the file');
    return `download-${res.downloadId}`;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function reportError(e) {
  console.error('[LiveKeep]', e);
  lastError = { message: e?.message || String(e), at: Date.now() };
}

async function uploadLoop() {
  while (true) {
    try {
      await pumpAll({ getToken, saveLocal });
      lastError = null;
      backoffMs = 0;
    } catch (e) {
      reportError(e);
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 5000, 60_000);
    }
    await report().catch(reportError);
    await sleep(backoffMs || IDLE_POLL_MS);
  }
}

addEventListener('online', () => { backoffMs = 0; wake?.(); });

// ---- Status ------------------------------------------------------------------

async function report() {
  const parts = await db.allParts();
  const recordings = {};
  for (const p of parts) {
    const r = (recordings[p.recordingId] ??= { recordedBytes: 0, uploadedBytes: 0, parts: 0, partsSaved: 0, partsFailed: 0 });
    r.recordedBytes += p.written;
    r.uploadedBytes += p.uploaded;
    r.parts += 1;
    if (p.done) r.partsSaved += 1;
    if (!p.closed) r.open = true; // still being written, e.g. by a page recorder
    if (p.failed) r.partsFailed += 1;
  }
  const finished = [];
  for (const [id, r] of Object.entries(recordings)) {
    if (recorders.has(id) || r.open) r.state = 'recording';
    else if (r.partsSaved + r.partsFailed === r.parts) { r.state = r.partsFailed ? 'partial' : 'done'; finished.push(id); }
    else r.state = 'uploading';
  }
  const idle = recorders.size === 0 && Object.values(recordings).every((r) => r.state === 'done' || r.state === 'partial');
  const res = await notify({ type: 'snapshot', snapshot: { recordings, lastError, online: navigator.onLine, idle } });
  // Once the service worker has the final numbers, the local bookkeeping can go, except
  // for recordings it still considers running (a watch-list recording between parts).
  const done = finished.filter((id) => !res?.active?.includes(id));
  if (res && done.length) {
    await db.deleteParts(parts.filter((p) => done.includes(p.recordingId)).map((p) => p.id));
  }
}

async function notify(msg) {
  try {
    const res = await chrome.runtime.sendMessage({ to: 'sw', ...msg });
    return res?.ok ? res : null;
  } catch {
    return null;
  }
}

// ---- Messages ----------------------------------------------------------------

const handlers = {
  start: (msg) => startRecording(msg),
  stop: async ({ recordingId }) => { await recorders.get(recordingId)?.stop(); },
  setMuted: async ({ recordingId, muted }) => { recorders.get(recordingId)?.setMuted(muted); },
  // Recordings made inside a YouTube tab (watch list) stream their bytes here part by part.
  // Messages arrive strictly in order: a part's chunks and close come before the next part.
  pagePart: async ({ recording, mimeType, ext, split }) => {
    await ready;
    const parts = (await db.allParts()).filter((p) => p.recordingId === recording.id);
    // A part left open by a page that reloaded mid-recording ends where its data ends.
    for (const p of parts) if (!p.closed) await db.updatePart(p.id, (x) => { x.closed = true; });
    const index = parts.length ? Math.max(...parts.map((p) => p.index)) + 1 : 0;
    const id = partId(recording.id, index);
    await db.putPart({
      id,
      recordingId: recording.id,
      index,
      name: partName(recording.fileBase, index, split, ext),
      mimeType,
      destination: recording.destination,
      folderId: recording.folderId,
      localDir: recording.localDir,
      written: 0,
      uploaded: 0,
      closed: false,
      done: false,
      failed: false,
      sessionUri: null,
      fileId: null,
      createdAt: Date.now(),
    });
    report().catch(reportError);
    return { partId: id };
  },
  pageChunk: async ({ partId: id, data }) => {
    const blob = await (await fetch(data)).blob(); // data: URL, since messages carry only JSON
    await db.appendChunk(id, blob);
    pageBytes += blob.size;
    if (pageBytes >= KICK_BYTES) { pageBytes = 0; kickUploads(); }
  },
  pagePartClosed: async ({ partId: id }) => {
    await db.updatePart(id, (p) => { p.closed = true; });
    kickUploads();
  },
  // The page recorder's tab went away; whatever it sent is all there will be.
  closeParts: async ({ recordingId }) => {
    for (const p of await db.allParts()) {
      if (p.recordingId === recordingId && !p.closed) await db.updatePart(p.id, (x) => { x.closed = true; });
    }
    kickUploads();
  },
  // From the watched tab's content script (sender.tab) or the service worker (recordingId).
  region: async ({ recordingId, region }, sender) => {
    for (const recorder of recorders.values()) {
      if (recorder.rec.id === recordingId || (sender.tab && recorder.rec.tabId === sender.tab.id)) {
        recorder.cropper.setRegion(region);
      }
    }
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

// Anything unfinished in IndexedDB at load time belongs to a recorder that died
// with a previous document (crash, browser restart). Close those parts so the
// uploader finalizes them with whatever was captured.
const ready = (async () => {
  for (const p of await db.allParts()) {
    if (!p.closed) await db.updatePart(p.id, (part) => { part.closed = true; });
  }
})();
ready.catch(reportError).then(uploadLoop);
