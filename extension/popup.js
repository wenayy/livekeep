import { DESTINATIONS, loadSettings } from './lib/settings.js';
import { parseWatchInput } from './lib/youtube.js';

const main = document.getElementById('main');
const historyEl = document.getElementById('history');
const historyList = document.getElementById('history-list');
const uploadStatusEl = document.getElementById('upload-status');

let tab = null;
let recordings = {};
let uploadStatus = null;
let account = null;
let watchlist = [];
let destination = 'drive';
let busy = null; // name of the action in flight
let actionError = null;

document.getElementById('settings').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function svg(markup) {
  const wrap = document.createElement('span');
  wrap.className = 'icon';
  wrap.innerHTML = markup; // static, trusted markup only
  return wrap;
}

const GOOGLE_G = '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

const watchForm = document.getElementById('watch-form');
const watchInput = document.getElementById('watch-input');
const watchAdd = document.getElementById('watch-add');
const watchThis = document.getElementById('watch-this');
const watchError = document.getElementById('watch-error');
const watchListEl = document.getElementById('watch-list');

const isYouTubeVideo = (url) => /^https:\/\/www\.youtube\.com\/(watch\?|live\/)/.test(url ?? '');

function mb(bytes = 0) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage({ to: 'sw', ...msg });
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong');
  return res;
}

async function act(name, fn) {
  busy = name;
  actionError = null;
  render();
  try {
    await fn();
  } catch (e) {
    actionError = e.message;
  } finally {
    busy = null;
    render();
  }
}

const activeRecording = () => Object.values(recordings)
  .find((r) => r.tabId === tab?.id && (r.state === 'recording' || r.state === 'starting'));

// ---- Where to save -------------------------------------------------------------

function renderDestination() {
  const choice = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Save recordings to' },
    ...Object.entries(DESTINATIONS).map(([value, label]) => h('button', {
      role: 'radio',
      'aria-checked': String(destination === value),
      class: destination === value ? 'on' : '',
      onclick: async () => {
        destination = value;
        await chrome.storage.sync.set({ destination: value });
        render();
      },
    }, label)));

  let detail;
  if (destination === 'local') {
    detail = h('p', { class: 'note' }, 'Saved to your Downloads folder, one file every few minutes. No account needed.');
  } else if (account) {
    detail = h('div', { class: 'account' },
      account.photo
        ? h('img', { src: account.photo, alt: '', width: 22, height: 22, referrerpolicy: 'no-referrer' })
        : h('span', { class: 'avatar' }, (account.name || account.email || '?')[0].toUpperCase()),
      h('span', { class: 'email', title: account.email }, account.email),
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); act('signOut', () => send({ type: 'signOut' })); } },
        busy === 'signOut' ? 'Signing out…' : 'Sign out'));
  } else {
    detail = h('div', {},
      h('button', {
        class: 'google',
        disabled: !!busy,
        onclick: () => act('signIn', async () => { ({ account } = await send({ type: 'signIn' })); }),
      }, svg(GOOGLE_G), busy === 'signIn' ? 'Signing in…' : 'Sign in with Google'),
      h('p', { class: 'note' }, 'LiveKeep can only see the recordings it saves, nothing else in your Drive.'));
  }

  return h('section', { class: 'destination' }, h('h2', {}, 'Save to'), choice, detail);
}

// ---- Current tab ---------------------------------------------------------------

function filesLink(rec, label) {
  if (rec.destination === 'local') {
    return h('a', { href: '#', onclick: (e) => { e.preventDefault(); send({ type: 'showFiles', recordingId: rec.id }); } }, label);
  }
  return rec.folderUrl ? h('a', { href: rec.folderUrl, target: '_blank' }, label) : null;
}

function renderRecording(rec) {
  const local = rec.destination === 'local';
  const pending = Math.max(0, (rec.recordedBytes ?? 0) - (rec.uploadedBytes ?? 0));
  const pct = rec.recordedBytes ? Math.min(100, (100 * rec.uploadedBytes) / rec.recordedBytes) : 0;
  return h('div', { class: 'card' },
    h('div', { class: 'live' },
      h('span', { class: 'dot' }),
      rec.state === 'starting' ? 'Starting…' : 'Recording',
      h('span', { class: 'time', id: 'elapsed' }, duration(Date.now() - rec.startedAt))),
    h('p', { class: 'title', style: 'margin-top:8px' }, rec.title),
    h('p', { class: 'muted', style: 'margin:0' }, local ? 'Saving to this computer' : 'Saving to Google Drive'),
    rec.notice ? h('p', { class: 'notice' },
      `YouTube shows “${rec.notice.reason}”. Still recording until you press Stop. Everything so far is saved.`) : null,
    local
      ? h('dl', { class: 'stats' },
        h('dt', {}, 'Recorded so far'), h('dd', {}, mb(rec.recordedBytes)),
        rec.partsSaved ? [h('dt', {}, 'Files in Downloads'), h('dd', {}, String(rec.partsSaved))] : null)
      : h('dl', { class: 'stats' },
        h('dt', {}, 'Uploaded'), h('dd', {}, mb(rec.uploadedBytes)),
        h('dt', {}, 'Waiting to upload'), h('dd', {}, mb(pending))),
    local ? h('p', { class: 'note' }, 'Kept safely on this computer while recording. The file lands in Downloads when you press Stop.')
      : h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'row' },
      h('label', { class: 'toggle', title: 'Silences your speakers only. The recording keeps the sound.' },
        h('input', {
          type: 'checkbox',
          checked: !!rec.muted,
          onchange: (e) => act('mute', () => send({ type: 'setMuted', recordingId: rec.id, muted: e.target.checked })),
        }),
        'Mute for me'),
      filesLink(rec, local ? 'Show files' : 'Open in Drive')),
    h('button', { class: 'stop', disabled: !!busy, onclick: () => act('stop', () => send({ type: 'stop', recordingId: rec.id })) },
      'Stop and save'));
}

function renderMain() {
  const active = activeRecording();
  if (active) return renderRecording(active);

  if (!isYouTubeVideo(tab?.url)) {
    return h('div', { class: 'card' },
      h('p', { class: 'title' }, 'Open a YouTube livestream'),
      h('p', { class: 'muted', style: 'margin:0' }, 'Then click the LiveKeep icon and press Record. You can keep watching while it saves.'));
  }

  const where = destination === 'local' ? 'your computer' : 'your Google Drive';
  return h('div', {},
    h('div', { class: 'card' },
      h('p', { class: 'title' }, (tab.title ?? '').replace(/ - YouTube$/, '')),
      h('p', { class: 'muted', style: 'margin:0' },
        `Records this tab and saves it to ${where} as it goes. If the stream goes private, everything up to that moment is kept.`)),
    h('button', {
      class: 'record',
      disabled: !!busy,
      onclick: () => act('start', () => send({ type: 'start', tabId: tab.id })),
    }, busy === 'start' ? 'Starting…' : 'Record this stream'),
    h('p', { class: 'note' }, 'Only the video is recorded, full frame. Keep it on screen: if you scroll it out of view, that part is black. Use “Mute for me” instead of muting YouTube, or the recording will be silent too.'));
}

// ---- Watch list ----------------------------------------------------------------

function when(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (offset) => { const x = new Date(); x.setDate(x.getDate() + offset); return x.toDateString(); };
  if (d.toDateString() === day(0)) return `today ${time}`;
  if (d.toDateString() === day(1)) return `tomorrow ${time}`;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function ago(ms) {
  const minutes = Math.round((Date.now() - (ms ?? Date.now())) / 60_000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

async function addToWatchlist(payload) {
  watchAdd.disabled = true;
  watchThis.disabled = true;
  watchError.hidden = true;
  try {
    await send({ type: 'watchAdd', ...payload });
    watchInput.value = '';
  } catch (e) {
    watchError.textContent = e.message;
    watchError.hidden = false;
  } finally {
    watchAdd.disabled = false;
    watchThis.disabled = false;
  }
}

watchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (watchInput.value.trim()) addToWatchlist({ input: watchInput.value });
});
watchThis.addEventListener('click', () => addToWatchlist({ tabId: tab.id }));

function watchStatus(w) {
  const rec = w.recordingId && recordings[w.recordingId];
  if (rec?.state === 'starting') return { text: 'Live: opening the stream (waiting out any ads)…', rec: true };
  if (rec?.state === 'recording') {
    return {
      rec: true,
      text: 'Recording ',
      elapsedFrom: rec.startedAt,
      actions: [
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); send({ type: 'showRecording', recordingId: rec.id }); } }, 'Show'),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); send({ type: 'stop', recordingId: rec.id }); } }, 'Stop'),
      ],
    };
  }
  switch (w.status) {
    case 'checking': return { text: 'Checking…' };
    case 'live': return { text: w.skip?.includes(w.liveVideoId) ? 'Live now (you stopped this one)' : 'Live now: starting…' };
    case 'upcoming':
      if (!w.scheduledAt) return { text: 'Stream scheduled' };
      return { text: w.scheduledAt > Date.now() ? `Scheduled ${when(w.scheduledAt)}` : `Was due ${when(w.scheduledAt)}: waiting for it to start` };
    case 'ended': return { text: 'Stream ended' };
    case 'error': return { text: `Couldn’t check: ${w.error}` };
    default: return { text: `Not live · checked ${ago(w.checkedAt)}` };
  }
}

function renderWatchlist() {
  watchListEl.replaceChildren(...watchlist.map((w) => {
    const status = watchStatus(w);
    const name = w.channel || w.label || w.title || (w.kind === 'video' ? 'Stream' : 'Channel');
    return h('li', {},
      h('span', { class: 'name', title: w.title ? `${name} · ${w.title}` : name }, name),
      h('span', { class: status.rec ? 'line rec' : 'line' },
        status.text,
        status.elapsedFrom ? h('span', { 'data-elapsed': status.elapsedFrom }, duration(Date.now() - status.elapsedFrom)) : null,
        ...(status.actions ?? []).flatMap((a) => [' · ', a])),
      h('button', { class: 'remove', title: 'Stop watching (a recording in progress continues)', 'aria-label': `Remove ${name}`,
        onclick: () => send({ type: 'watchRemove', id: w.id }) }, '×'));
  }));

  // Offer the channel of the page you're on.
  const here = parseWatchInput(tab?.url ?? '');
  const watched = here?.kind === 'channel' && watchlist.some((w) => w.channelUrl?.toLowerCase() === here.channelUrl.toLowerCase());
  watchThis.hidden = !here || watched;
}

// ---- History & status ----------------------------------------------------------

const STATE_LABEL = {
  uploading: 'Finishing…',
  done: 'Saved',
  partial: 'Saved, but some parts failed',
  error: 'Failed',
};

function renderHistory() {
  const past = Object.values(recordings)
    .filter((r) => r.state !== 'recording' && r.state !== 'starting')
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 5);
  historyEl.hidden = past.length === 0;
  historyList.replaceChildren(...past.map((r) => {
    const parts = [STATE_LABEL[r.state] ?? r.state];
    if (r.state === 'uploading') parts.push(`${mb(r.uploadedBytes)} of ${mb(r.recordedBytes)}`);
    else if (r.recordedBytes) parts.push(mb(r.recordedBytes));
    if (r.stopReason && r.state !== 'done') parts.push(r.stopReason);
    return h('li', {},
      h('span', { class: 't', title: r.title }, r.title),
      h('span', { class: 's' }, parts.join(' · ')),
      filesLink(r, r.destination === 'local' ? 'Files' : 'Drive'));
  }));
}

function renderUploadStatus() {
  const pendingDrive = Object.values(recordings)
    .some((r) => r.destination !== 'local' && (r.state === 'uploading' || r.state === 'recording'));
  const message = uploadStatus?.lastError?.message ?? '';
  let line = null;
  if (uploadStatus?.online === false && pendingDrive) line = 'You are offline. Recording continues and uploads resume when you reconnect.';
  else if (/not signed in/i.test(message)) line = pendingDrive ? 'Sign in with Google to finish uploading. Nothing is lost in the meantime.' : null;
  else if (message) line = `Problem saving, retrying: ${message}`;
  uploadStatusEl.hidden = !line;
  uploadStatusEl.textContent = line ?? '';
}

function render() {
  const recordingHere = !!activeRecording();
  main.replaceChildren(
    renderMain(),
    ...(actionError ? [h('p', { class: 'error' }, actionError)] : []),
    ...(recordingHere ? [] : [renderDestination()]),
  );
  renderWatchlist();
  renderHistory();
  renderUploadStatus();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.destination) destination = changes.destination.newValue ?? 'drive';
  if (area === 'local') {
    if (changes.recordings) recordings = changes.recordings.newValue ?? {};
    if (changes.uploadStatus) uploadStatus = changes.uploadStatus.newValue ?? null;
    if (changes.account) account = changes.account.newValue ?? null;
    if (changes.watchlist) watchlist = changes.watchlist.newValue ?? [];
  }
  if (!busy) render();
});

setInterval(() => {
  const el = document.getElementById('elapsed');
  const active = activeRecording();
  if (el && active?.state === 'recording') el.textContent = duration(Date.now() - active.startedAt);
  for (const span of document.querySelectorAll('[data-elapsed]')) span.textContent = duration(Date.now() - Number(span.dataset.elapsed));
}, 1000);

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ({ recordings = {}, uploadStatus = null, account = null, watchlist = [] } =
    await chrome.storage.local.get(['recordings', 'uploadStatus', 'account', 'watchlist']));
  ({ destination } = await loadSettings());
  render();
  // Confirm the cached account still works; storage.onChanged re-renders if it doesn't.
  send({ type: 'authStatus' }).catch(() => {});
})();
