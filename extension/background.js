// Service worker: signs in to Google, prepares where the recording goes (a Drive
// folder or a Downloads subfolder), hands the tab's capture stream to the offscreen
// recorder, and stops recordings when the stream disappears. Recording metadata
// lives in chrome.storage.local under `recordings`; the signed-in account under `account`.

import * as drive from './lib/drive.js';
import * as db from './lib/db.js';
import { getToken, signOut, isConfigured } from './lib/auth.js';
import { loadSettings, QUALITY } from './lib/settings.js';
import { parseWatchInput, statusUrl, readLiveStatus } from './lib/youtube.js';

const OFFSCREEN_URL = 'offscreen.html';
const MAX_HISTORY = 20;

function videoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.youtube.com') return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    return u.pathname.match(/^\/live\/([\w-]{11})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

// ---- Account -----------------------------------------------------------------

async function signIn() {
  if (!isConfigured()) throw new Error('Google sign-in is not configured in this build.');
  const token = await getToken({ interactive: true });
  const account = await drive.getUser(token);
  await chrome.storage.local.set({ account });
  return { account };
}

// Checks silently whether we still hold a working token; never shows UI.
async function authStatus() {
  try {
    const token = await getToken();
    let { account } = await chrome.storage.local.get('account');
    if (!account) {
      account = await drive.getUser(token);
      await chrome.storage.local.set({ account });
    }
    return { account };
  } catch {
    await chrome.storage.local.remove('account');
    return { account: null };
  }
}

// ---- Recording metadata ------------------------------------------------------

let writeQueue = Promise.resolve();

function updateRecordings(mutate) {
  const next = writeQueue.then(async () => {
    const { recordings = {} } = await chrome.storage.local.get('recordings');
    mutate(recordings);
    const ids = Object.keys(recordings).sort().reverse();
    for (const id of ids.slice(MAX_HISTORY)) {
      if (!['starting', 'recording', 'uploading'].includes(recordings[id].state)) delete recordings[id];
    }
    await chrome.storage.local.set({ recordings });
    return recordings;
  });
  writeQueue = next.catch(() => {});
  return next;
}

async function getRecordings() {
  const { recordings = {} } = await chrome.storage.local.get('recordings');
  return recordings;
}

async function activeRecordingForTab(tabId) {
  return Object.values(await getRecordings())
    .find((r) => r.tabId === tabId && (r.state === 'recording' || r.state === 'starting'));
}

async function updateBadge(recordings) {
  const all = Object.values(recordings ?? (await getRecordings()));
  if (all.some((r) => r.state === 'recording' || r.state === 'starting')) {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    await chrome.action.setBadgeText({ text: 'REC' });
  } else if (all.some((r) => r.state === 'uploading')) {
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
    await chrome.action.setBadgeText({ text: '↑' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ---- Offscreen document ------------------------------------------------------

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record the livestream tab and upload it to Google Drive',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function toOffscreen(msg) {
  const res = await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
  if (!res?.ok) throw new Error(res?.error || 'Recorder did not respond');
  return res;
}

// ---- Start / stop ------------------------------------------------------------

async function pageInfo(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'info' });
  } catch {
    // Tab was open before the extension was installed: inject the watcher now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'info' }).catch(() => null);
  }
}

// Safe as a Drive name and as a Windows/macOS path segment.
const safeName = (s) => s.replace(/[\\/:*?"<>|~\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

// Creates the Drive folder (or picks the Downloads subfolder) for a new recording.
// Unattended recordings can't show a sign-in window, so if Google isn't signed in
// they save to this computer instead and say so.
async function prepareDestination({ settings, title, channel, url, startedAt, interactive }) {
  const folderName = safeName(`${stamp(startedAt)} · ${channel ? `${channel} · ` : ''}${title}`);
  const local = (notice = null) => ({
    destination: 'local',
    folderId: null,
    folderUrl: null,
    localDir: `${safeName(settings.folderName) || 'LiveKeep Recordings'}/${folderName}`,
    notice,
  });
  if (settings.destination !== 'drive') return local();

  let token;
  if (interactive) {
    await signIn();
    token = await getToken();
  } else {
    token = await getToken().catch(() => null);
    if (!token) return local({ reason: 'Not signed in to Google, so this one is saved to this computer.', at: Date.now() });
  }
  const { rootFolder } = await chrome.storage.local.get('rootFolder');
  const cachedId = rootFolder?.name === settings.folderName ? rootFolder.id : null;
  const rootId = await drive.ensureRootFolder(token, settings.folderName, cachedId);
  await chrome.storage.local.set({ rootFolder: { name: settings.folderName, id: rootId } });
  const folderId = await drive.createFolder(token, folderName, rootId,
    `Recorded by LiveKeep from ${url}\nTitle: ${title}\nChannel: ${channel ?? 'unknown'}\nStarted: ${new Date(startedAt).toString()}`);
  return { destination: 'drive', folderId, folderUrl: drive.folderUrl(folderId), localDir: null, notice: null };
}

async function startRecording({ tabId }) {
  const existing = await activeRecordingForTab(tabId);
  if (existing) return { recordingId: existing.id };

  const tab = await chrome.tabs.get(tabId);
  const videoId = videoIdFromUrl(tab.url);
  if (!videoId) throw new Error('Open a YouTube live stream in this tab first.');

  const settings = await loadSettings();
  // Sign in first (if needed) so a cancelled sign-in doesn't leave anything behind.
  if (settings.destination === 'drive') await signIn();
  const page = (await pageInfo(tabId)) ?? {};
  const startedAt = Date.now();
  // Tab titles look like "(3) Stream title - YouTube"; keep just the stream title.
  const tabTitle = tab.title?.replace(/^\(\d+\)\s*/, '').replace(/(?:^|\s*-\s*)YouTube$/, '').trim();
  const title = safeName(page.title || tabTitle || `YouTube ${videoId}`);
  const channel = page.channel ? safeName(page.channel) : null;
  const url = watchUrl(videoId);
  const { destination, folderId, folderUrl, localDir } =
    await prepareDestination({ settings, title, channel, url, startedAt, interactive: false });

  const recording = {
    id: `rec-${startedAt}`,
    tabId,
    videoId,
    url,
    title,
    channel,
    destination,
    folderId,
    folderUrl,
    localDir,
    lastDownloadId: null,
    startedAt,
    endedAt: null,
    stopReason: null,
    state: 'starting',
    muted: false,
    recordedBytes: 0,
    uploadedBytes: 0,
    parts: 0,
    partsSaved: 0,
  };
  await updateRecordings((r) => { r[recording.id] = recording; });

  try {
    // Ask for the stream id last: it must be consumed within a few seconds.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    await toOffscreen({
      type: 'start',
      streamId,
      settings,
      region: page.region ?? null,
      recording: { id: recording.id, tabId, destination, folderId, localDir, fileBase: safeName(title).slice(0, 80) },
    });
  } catch (e) {
    await updateRecordings((r) => { r[recording.id].state = 'error'; r[recording.id].stopReason = e.message; });
    await updateBadge();
    throw e;
  }
  let stoppedWhileStarting = false;
  await updateBadge(await updateRecordings((r) => {
    if (r[recording.id].state === 'starting') r[recording.id].state = 'recording';
    else stoppedWhileStarting = true;
  }));
  // The tab navigated or was closed while we were still setting up.
  if (stoppedWhileStarting) await toOffscreen({ type: 'stop', recordingId: recording.id });
  // From now on the page keeps the recorder told where the video is.
  else await chrome.tabs.sendMessage(tabId, { type: 'track', on: true }).catch(() => {});
  return { recordingId: recording.id };
}

async function stopRecording(recordingId, reason) {
  let stopped = null;
  const recordings = await updateRecordings((r) => {
    const rec = r[recordingId];
    if (rec?.state !== 'recording' && rec?.state !== 'starting') return;
    stopped = rec;
    rec.state = 'uploading';
    rec.endedAt = Date.now();
    rec.stopReason = reason;
  });
  if (stopped?.mode === 'auto') {
    // The page recorder finishes its last part, then reports autoFinished and its window
    // is closed. If the page is already gone, close out whatever it sent.
    chrome.tabs.sendMessage(stopped.tabId, { type: 'autoStop', recordingId })
      .catch(() => finishAuto(recordingId));
  } else if (stopped) {
    if (await hasOffscreen()) await toOffscreen({ type: 'stop', recordingId });
    chrome.tabs.sendMessage(stopped.tabId, { type: 'track', on: false }).catch(() => {});
  }
  await updateBadge(recordings);
}

// After a watch-list recording: make sure its parts are closed, then close its window.
async function finishAuto(recordingId) {
  const rec = (await getRecordings())[recordingId];
  if (await hasOffscreen()) await toOffscreen({ type: 'closeParts', recordingId }).catch(() => {});
  if (rec?.windowId != null) await chrome.windows.remove(rec.windowId).catch(() => {});
}

async function stopTab(tabId, reason) {
  const rec = await activeRecordingForTab(tabId);
  if (rec) await stopRecording(rec.id, reason);
}

// ---- Snapshot from the recorder ----------------------------------------------

async function applySnapshot({ recordings: stats, lastError, online, idle }) {
  const recordings = await updateRecordings((r) => {
    for (const [id, s] of Object.entries(stats)) {
      const rec = (r[id] ??= { id, title: 'Recovered recording', startedAt: Number(id.slice(4)) || Date.now() });
      if (rec.state === 'starting' || (rec.mode === 'auto' && rec.state === 'recording')) {
        // Unattended recordings end through their tab (it may be between parts right now).
        Object.assign(rec, { ...s, state: rec.state });
        continue;
      }
      // A recording the user stopped stays "uploading" until the recorder confirms it.
      const state = s.state === 'recording' && rec.state !== 'recording' ? 'uploading' : s.state;
      Object.assign(rec, { ...s, state });
    }
    // Recordings the recorder no longer knows about can't be "recording" any more.
    for (const rec of Object.values(r)) {
      if (rec.mode === 'auto' && rec.state === 'recording') continue;
      if ((rec.state === 'recording' || rec.state === 'uploading') && !stats[rec.id]) {
        rec.state = rec.partsSaved ? 'done' : 'error';
        rec.stopReason ??= 'Recorder stopped unexpectedly';
      }
    }
  });
  await chrome.storage.local.set({ uploadStatus: { lastError, online, at: Date.now() } });
  await updateBadge(recordings);
  const active = Object.values(recordings)
    .filter((r) => r.state === 'starting' || r.state === 'recording')
    .map((r) => r.id);
  if (idle && !active.length) await chrome.offscreen.closeDocument().catch(() => {});
  return { active };
}

// ---- Saving to this computer -------------------------------------------------

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const settle = (state, error) => {
      if (state === 'complete') { chrome.downloads.onChanged.removeListener(listener); resolve(); }
      if (state === 'interrupted') { chrome.downloads.onChanged.removeListener(listener); reject(new Error(`Saving the file failed (${error ?? 'interrupted'})`)); }
    };
    const listener = (delta) => {
      if (delta.id === downloadId && delta.state) settle(delta.state.current, delta.error?.current);
    };
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id: downloadId }).then(([item]) => item && settle(item.state, item.error));
  });
}

async function saveDownload({ url, filename, recordingId }) {
  const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  await waitForDownload(downloadId);
  await updateRecordings((r) => { if (r[recordingId]) r[recordingId].lastDownloadId = downloadId; });
  return { downloadId };
}

async function showFiles({ recordingId }) {
  const rec = (await getRecordings())[recordingId];
  const [item] = rec?.lastDownloadId ? await chrome.downloads.search({ id: rec.lastDownloadId }) : [];
  if (item?.exists) chrome.downloads.show(item.id);
  else chrome.downloads.showDefaultFolder();
}

// ---- Watch list -----------------------------------------------------------------
// Channels or streams to record automatically when they go live, checked from the
// user's own browser. storage.local `watchlist`: [{ id, kind, channelUrl | videoId,
// label, title, channel, status, scheduledAt, liveVideoId, recordingId, checkedAt,
// error, skip: [videoIds the user stopped by hand] }]

const WATCH_ALARM = 'watch';
const START_TIMEOUT_MS = 4 * 60_000;

let watchQueue = Promise.resolve();

function updateWatchlist(mutate) {
  const next = watchQueue.then(async () => {
    const { watchlist = [] } = await chrome.storage.local.get('watchlist');
    mutate(watchlist);
    await chrome.storage.local.set({ watchlist });
    return watchlist;
  });
  watchQueue = next.catch(() => {});
  return next;
}

async function getWatchlist() {
  const { watchlist = [] } = await chrome.storage.local.get('watchlist');
  return watchlist;
}

const watchKey = (w) => (w.kind === 'channel' ? w.channelUrl.toLowerCase() : w.videoId);

async function ensureWatchAlarm() {
  if (!(await chrome.alarms.get(WATCH_ALARM))) await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
}

// How long until an item should be checked again.
function checkInterval(item) {
  if (item.kind === 'video' && item.status === 'ended') return Infinity;
  if (item.status === 'upcoming' && item.scheduledAt && item.scheduledAt - Date.now() > 60 * 60_000) return 10 * 60_000;
  if (item.status === 'upcoming' || item.status === 'error') return 60_000;
  return 2 * 60_000;
}

async function watchAdd({ input, tabId }) {
  let item = parseWatchInput(input);
  if (!item && tabId != null) {
    // "Watch this channel" from a video page: watch its channel, not just this video.
    const tab = await chrome.tabs.get(tabId);
    item = parseWatchInput(tab.url);
    if (item?.kind === 'video') {
      const channel = parseWatchInput((await pageInfo(tabId))?.channelUrl);
      if (channel) item = channel;
    }
  }
  if (!item) throw new Error('That isn’t a YouTube channel or stream link.');
  let added = null;
  await updateWatchlist((list) => {
    if (list.some((w) => watchKey(w) === watchKey(item))) return;
    added = { id: `w-${Date.now()}`, ...item, status: 'checking', skip: [], addedAt: Date.now() };
    list.push(added);
  });
  if (!added) throw new Error('That’s already on your watch list.');
  await ensureWatchAlarm();
  await checkWatch(added.id);
  return {};
}

async function checkWatch(id) {
  const item = (await getWatchlist()).find((w) => w.id === id);
  if (!item) return;
  const rec = item.recordingId && (await getRecordings())[item.recordingId];
  if (rec && (rec.state === 'starting' || rec.state === 'recording')) return; // busy recording it

  let status;
  try {
    const res = await fetch(statusUrl(item), { credentials: 'include' });
    if (new URL(res.url).hostname.startsWith('consent.')) throw new Error('Open youtube.com once and accept its cookie notice');
    if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
    status = readLiveStatus(await res.text());
  } catch (e) {
    await updateWatchlist((list) => {
      const w = list.find((x) => x.id === id);
      if (w) Object.assign(w, { status: 'error', error: e.message, checkedAt: Date.now() });
    });
    return;
  }
  await updateWatchlist((list) => {
    const w = list.find((x) => x.id === id);
    if (!w) return;
    Object.assign(w, {
      status: status.state,
      error: null,
      checkedAt: Date.now(),
      scheduledAt: status.scheduledAt ?? null,
      liveVideoId: status.videoId ?? null,
      title: status.title ?? w.title ?? null,
      channel: status.channel ?? w.channel ?? null,
    });
  });
  if (status.state === 'live' && !item.skip?.includes(status.videoId)) {
    await startAutoRecording(id, status).catch((e) => updateWatchlist((list) => {
      const w = list.find((x) => x.id === id);
      if (w) Object.assign(w, { status: 'error', error: `Couldn’t start recording: ${e.message}` });
    }));
  }
}

async function runWatchChecks() {
  // Recordings that never got going (the stream wouldn't play) are given up on.
  for (const rec of Object.values(await getRecordings())) {
    if (rec.mode === 'auto' && rec.state === 'starting' && Date.now() - rec.startedAt > START_TIMEOUT_MS) {
      await stopRecording(rec.id, 'The stream didn’t start playing');
      await finishAuto(rec.id);
    }
  }
  for (const item of await getWatchlist()) {
    if (Date.now() - (item.checkedAt ?? 0) >= checkInterval(item) - 5000) {
      await checkWatch(item.id).catch(() => {});
    }
  }
}

// Opens the live stream in its own small window and has the page record it.
// The window must be shown once: Chrome doesn't load video in never-shown tabs.
async function startAutoRecording(watchId, status) {
  const settings = await loadSettings();
  const startedAt = Date.now();
  const title = safeName(status.title || `YouTube ${status.videoId}`);
  const channel = status.channel ? safeName(status.channel) : null;
  const url = watchUrl(status.videoId);
  const dest = await prepareDestination({ settings, title, channel, url, startedAt, interactive: false });

  const win = await chrome.windows.create({ url, focused: false, width: 640, height: 420 });
  const tabId = win.tabs[0].id;
  await chrome.tabs.update(tabId, { muted: true }); // silent for you; the recording keeps the sound

  const id = `rec-${startedAt}`;
  const recording = {
    id,
    mode: 'auto',
    watchId,
    tabId,
    windowId: win.id,
    videoId: status.videoId,
    url,
    title,
    channel,
    destination: dest.destination,
    folderId: dest.folderId,
    folderUrl: dest.folderUrl,
    localDir: dest.localDir,
    notice: dest.notice,
    lastDownloadId: null,
    startedAt,
    endedAt: null,
    stopReason: null,
    state: 'starting',
    recordedBytes: 0,
    uploadedBytes: 0,
    parts: 0,
    partsSaved: 0,
    job: {
      recording: { id, destination: dest.destination, folderId: dest.folderId, localDir: dest.localDir, fileBase: title.slice(0, 80) },
      quality: QUALITY[settings.quality],
      partMinutes: settings.partMinutes,
    },
  };
  await updateRecordings((r) => { r[id] = recording; });
  await updateWatchlist((list) => {
    const w = list.find((x) => x.id === watchId);
    if (w) Object.assign(w, { status: 'recording', recordingId: id });
  });
  await ensureOffscreen();
  // The page asks for its job when it loads ("hello"); this covers a page that loaded first.
  chrome.tabs.sendMessage(tabId, { type: 'autoRecord', job: recording.job }).catch(() => {});
  await updateBadge();
}

async function autoStarted({ recordingId, mutedFallback }) {
  let windowId = null;
  await updateBadge(await updateRecordings((r) => {
    const rec = r[recordingId];
    if (!rec) return;
    if (rec.state === 'starting') rec.state = 'recording';
    windowId = rec.windowId;
    if (mutedFallback) {
      rec.notice = { reason: 'Chrome wouldn’t autoplay this with sound, so keep the LiveKeep window visible or it may pause.', at: Date.now() };
    }
  }));
  // Out of the way once it's recording. Unmuted playback keeps going while minimized.
  if (windowId != null && !mutedFallback) await chrome.windows.update(windowId, { state: 'minimized' }).catch(() => {});
}

// YouTube's player showed an error or the video ended in an unattended recording.
// If the stream is in fact still live, it was the player: reload and keep recording.
// Otherwise the stream is over (or gone private), so finish the recording.
async function autoTrouble(rec, reason) {
  let live = false;
  try {
    const res = await fetch(watchUrl(rec.videoId), { credentials: 'include' });
    live = readLiveStatus(await res.text()).state === 'live';
  } catch {
    // Can't tell; treat as over rather than reload forever.
  }
  const reloads = (rec.reloads ?? []).filter((t) => Date.now() - t < 10 * 60_000);
  if (live && reloads.length < 3) {
    await updateRecordings((r) => {
      const x = r[rec.id];
      if (!x) return;
      x.reloads = [...reloads, Date.now()];
      x.notice = { reason: `YouTube showed “${reason}”. LiveKeep reloaded the stream and kept recording.`, at: Date.now() };
    });
    // Un-minimize first: Chrome won't load video into a page that was never shown.
    if (rec.windowId != null) await chrome.windows.update(rec.windowId, { state: 'normal' }).catch(() => {});
    await chrome.tabs.reload(rec.tabId).catch(() => {});
    return;
  }
  await stopRecording(rec.id, live ? `Stopped after repeated YouTube errors (“${reason}”)` : reason);
}

async function autoProblem({ recordingId, message, fatal }) {
  if (fatal) {
    await stopRecording(recordingId, message);
    await finishAuto(recordingId);
  } else {
    await updateRecordings((r) => { if (r[recordingId]) r[recordingId].notice = { reason: message, at: Date.now() }; });
  }
}

// ---- Wiring ------------------------------------------------------------------

const handlers = {
  getToken: ({ stale }) => getToken({ stale }).then((token) => ({ token })),
  authStatus: () => authStatus(),
  signIn: () => signIn(),
  signOut: async () => { await signOut(); await chrome.storage.local.remove('account'); },
  download: (msg) => saveDownload(msg),
  showFiles: (msg) => showFiles(msg),
  start: (msg) => startRecording(msg),
  stop: async ({ recordingId }) => {
    const rec = (await getRecordings())[recordingId];
    if (rec?.mode === 'auto') {
      // Don't start recording this same stream again on the next check.
      await updateWatchlist((list) => {
        const w = list.find((x) => x.id === rec.watchId);
        if (w && !w.skip.includes(rec.videoId)) w.skip.push(rec.videoId);
      });
    }
    await stopRecording(recordingId, 'Stopped by you');
  },
  setMuted: async ({ recordingId, muted }) => {
    await updateRecordings((r) => { if (r[recordingId]) r[recordingId].muted = muted; });
    if (await hasOffscreen()) await toOffscreen({ type: 'setMuted', recordingId, muted });
  },
  snapshot: ({ snapshot }) => applySnapshot(snapshot),
  captureEnded: ({ recordingId }) => stopRecording(recordingId, 'Tab capture ended'),
  hello: async (_msg, sender) => {
    const rec = await activeRecordingForTab(sender.tab?.id);
    return { recording: !!rec && rec.mode !== 'auto', auto: rec?.mode === 'auto' ? rec.job : null };
  },
  // By default recordings keep going until the user presses Stop; the popup just
  // shows what YouTube said. Stopping automatically is opt-in.
  streamGone: async ({ reason, videoId }, sender) => {
    const rec = await activeRecordingForTab(sender.tab?.id);
    if (!rec || rec.videoId !== videoId) return;
    if (rec.mode === 'auto') await autoTrouble(rec, reason);
    else if ((await loadSettings()).autoStop) await stopRecording(rec.id, reason);
    else await updateRecordings((r) => { if (r[rec.id]) r[rec.id].notice = { reason, at: Date.now() }; });
  },
  retryUploads: () => ensureOffscreen(),
  ensureRecorder: () => ensureOffscreen(),
  autoStarted: (msg) => autoStarted(msg),
  autoProblem: (msg) => autoProblem(msg),
  autoFinished: ({ recordingId }) => finishAuto(recordingId),
  autoNeedsShow: async ({ recordingId }) => {
    const rec = (await getRecordings())[recordingId];
    if (rec?.windowId != null) await chrome.windows.update(rec.windowId, { state: 'normal', focused: true }).catch(() => {});
  },
  watchAdd: (msg) => watchAdd(msg),
  watchRemove: ({ id }) => updateWatchlist((list) => {
    const i = list.findIndex((w) => w.id === id);
    if (i >= 0) list.splice(i, 1);
  }).then(() => ({})),
  showRecording: async ({ recordingId }) => {
    const rec = (await getRecordings())[recordingId];
    if (rec?.windowId != null) await chrome.windows.update(rec.windowId, { state: 'normal', focused: true });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'sw') return;
  const handler = handlers[msg.type];
  if (!handler) return;
  Promise.resolve(handler(msg, sender)).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => stopTab(tabId, 'Tab closed'));

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url && change.status !== 'loading') return;
  const rec = await activeRecordingForTab(tabId);
  if (!rec) return;
  // Without host access to the new page, tab.url is undefined: the tab left YouTube.
  const url = change.url ?? tab.url;
  if (videoIdFromUrl(url) === rec.videoId) return;
  if (rec.mode === 'auto' || (await loadSettings()).autoStop) {
    await stopRecording(rec.id, 'Tab left the stream page');
  } else if (!url?.startsWith('https://www.youtube.com/') && (await hasOffscreen())) {
    // No content script there to report a video, so record the whole tab.
    await toOffscreen({ type: 'region', recordingId: rec.id, region: null }).catch(() => {});
  }
});

// After a crash or browser restart, finish uploading whatever was captured.
// Tab ids are reused across browser sessions, so old recordings must not stay "recording".
async function resumePendingUploads() {
  await updateRecordings((r) => {
    for (const rec of Object.values(r)) {
      if (rec.state === 'recording' || rec.state === 'starting') {
        rec.state = 'uploading';
        rec.stopReason ??= 'Browser was closed';
      }
    }
  });
  const pending = (await db.allParts()).some((p) => !p.done && !p.failed);
  if (pending) await ensureOffscreen();
  else await updateBadge();
}

chrome.runtime.onStartup.addListener(resumePendingUploads);
chrome.runtime.onInstalled.addListener(resumePendingUploads);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) runWatchChecks();
});
chrome.runtime.onStartup.addListener(() => getWatchlist().then((l) => l.length && ensureWatchAlarm()));
chrome.runtime.onInstalled.addListener(() => getWatchlist().then((l) => l.length && ensureWatchAlarm()));
