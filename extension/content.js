// Watches the YouTube page:
// - while this tab is being recorded, reports where the video sits on screen so the
//   recorder can crop to just the video;
// - when the player shows an error ("This video is private", "removed", ...) or the
//   stream ends, tells the service worker (which notes it, or stops if the user chose that).
// It never draws anything on the page: overlays would end up in the recording.

(() => {
  if (window.__liveKeepWatcher) return;
  window.__liveKeepWatcher = true;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // Extension was reloaded; this copy of the script is orphaned.
    }
  }

  // Grace periods so brief hiccups don't count.
  const GONE_AFTER_MS = { error: 20_000, ended: 15_000 };

  function videoId() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    return location.pathname.match(/^\/live\/([\w-]{11})/)?.[1] ?? null;
  }

  function info() {
    // ytd-channel-name repeats the name in a hidden tooltip, so keep only the first line.
    const text = (sel) => document.querySelector(sel)?.textContent?.trim().split('\n')[0].trim() || null;
    return {
      videoId: videoId(),
      // Before YouTube fills in the page, document.title is just "YouTube".
      title: text('ytd-watch-metadata h1') || document.title.replace(/^\(\d+\)\s*/, '').replace(/(?:^|\s*-\s*)YouTube$/, '').trim() || null,
      channel: text('ytd-watch-metadata ytd-channel-name') || text('#owner ytd-channel-name'),
      channelUrl: document.querySelector('ytd-video-owner-renderer a[href^="/@"], ytd-watch-metadata a[href^="/@"]')?.href ?? null,
      region: videoRegion(),
    };
  }

  // ---- Where the video is ------------------------------------------------------

  // The video's rectangle as fractions of the viewport (what tab capture sees).
  // Also works for the miniplayer; null when there's no video on screen to crop to.
  function videoRegion() {
    const video = document.querySelector('#movie_player video');
    const r = video?.getBoundingClientRect();
    if (!r || r.width < 2 || r.height < 2) return null;
    return {
      x: r.left / innerWidth,
      y: r.top / innerHeight,
      width: r.width / innerWidth,
      height: r.height / innerHeight,
      viewportAspect: innerWidth / innerHeight,
    };
  }

  let tracking = false;
  let lastRegionKey = null;

  function reportRegion() {
    if (!tracking) return;
    const region = videoRegion();
    const key = region ? Object.values(region).map((n) => n.toFixed(4)).join() : 'none';
    if (key === lastRegionKey) return;
    lastRegionKey = key;
    send({ to: 'offscreen', type: 'region', region });
  }

  function setTracking(on) {
    tracking = on;
    lastRegionKey = null;
    reportRegion();
  }

  let pending = false;
  const scheduleReport = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; reportRegion(); });
  };
  for (const event of ['resize', 'scroll', 'fullscreenchange', 'yt-navigate-finish']) {
    addEventListener(event, scheduleReport, { passive: true, capture: true });
  }
  setInterval(reportRegion, 500); // theater mode, miniplayer and layout shifts fire no event

  // ---- Watch-list recordings ---------------------------------------------------

  // A tab LiveKeep opened by itself records the player directly (see autorec.js).
  let auto = null;
  async function startAuto(job) {
    if (auto) return;
    auto = 'starting';
    try {
      const { AutoRecorder } = await import(chrome.runtime.getURL('autorec.js'));
      auto = new AutoRecorder(job);
      await auto.start();
    } catch (e) {
      send({ to: 'sw', type: 'autoProblem', recordingId: job.recording.id, message: e.message, fatal: true });
    }
  }
  async function stopAuto(recordingId) {
    if (auto && typeof auto.stop === 'function') await auto.stop();
    send({ to: 'sw', type: 'autoFinished', recordingId });
  }

  // After a reload or navigation in a tab that is still recording, pick up again.
  send({ to: 'sw', type: 'hello' }).then((res) => {
    if (res?.recording) setTracking(true);
    if (res?.auto) startAuto(res.auto);
  });

  // YouTube marks the watch page when the player can't play ("private", "removed", ...)
  // and shows the message in one of several screens depending on the case and UI version.
  const UNAVAILABLE_FLAG = 'ytd-watch-flexy[player-unavailable]:not([hidden])';
  const ERROR_SCREENS = [
    'ytd-watch-flexy #error-screen',
    'ytd-watch-flexy ytd-background-promo-renderer',
    '#movie_player .ytp-error',
    'ytd-player-error-message-renderer',
  ];

  const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);

  function errorText() {
    for (const selector of ERROR_SCREENS) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      const firstLine = el?.innerText?.split('\n').map((s) => s.trim()).find(Boolean);
      if (firstLine) return firstLine;
    }
    return null;
  }

  function playerProblem() {
    const text = errorText();
    if (text || document.querySelector(UNAVAILABLE_FLAG)) {
      return { kind: 'error', reason: text || 'Video became unavailable' };
    }
    const player = document.querySelector('#movie_player');
    if (!player) return null;
    if (player.querySelector('video')?.ended || player.classList.contains('ended-mode')) {
      return { kind: 'ended', reason: 'Stream ended' };
    }
    return null;
  }

  let current = null; // { kind, reason, since, id, reported }

  setInterval(() => {
    const id = videoId();
    const problem = playerProblem();
    if (!problem) { current = null; return; }
    if (!current || current.kind !== problem.kind || current.id !== id) {
      current = { ...problem, id, since: Date.now(), reported: false };
    }
    if (!current.reported && Date.now() - current.since >= GONE_AFTER_MS[current.kind]) {
      current.reported = true;
      send({ to: 'sw', type: 'streamGone', videoId: id, reason: current.reason });
    }
  }, 2000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'info') sendResponse(info());
    if (msg?.type === 'track') setTracking(!!msg.on);
    if (msg?.type === 'autoRecord') startAuto(msg.job);
    if (msg?.type === 'autoStop') stopAuto(msg.recordingId);
  });
})();
