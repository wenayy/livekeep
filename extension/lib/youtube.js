// Understands YouTube links and pages, for the watch list.

const VIDEO_ID = /^[\w-]{11}$/;

const video = (videoId) => ({ kind: 'video', videoId, label: null });

// What the user pasted -> { kind: 'video', videoId } | { kind: 'channel', channelUrl, label } | null
export function parseWatchInput(input) {
  let s = (input ?? '').trim();
  const handle = s.match(/^(@[^\s/?#]+)(?:[/?#].*)?$/);
  if (handle) return { kind: 'channel', channelUrl: `https://www.youtube.com/${handle[1]}`, label: handle[1] };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(?:www\.|m\.)/, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1, 12);
    return VIDEO_ID.test(id) ? video(id) : null;
  }
  if (host !== 'youtube.com') return null;
  if (u.pathname === '/watch') {
    const id = u.searchParams.get('v');
    return id && VIDEO_ID.test(id) ? video(id) : null;
  }
  const direct = u.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})(?:[/?#]|$)/);
  if (direct) return video(direct[1]);
  const channel = u.pathname.match(/^\/(@[^/?#]+|channel\/UC[\w-]{22}|c\/[^/?#]+|user\/[^/?#]+)/);
  if (channel) {
    const path = decodeURIComponent(channel[1]);
    return { kind: 'channel', channelUrl: `https://www.youtube.com/${path}`, label: path.startsWith('@') ? path : null };
  }
  return null;
}

// The page to load to find out whether something is live right now.
export function statusUrl(item) {
  return item.kind === 'channel'
    ? `${item.channelUrl}/live`
    : `https://www.youtube.com/watch?v=${item.videoId}`;
}

// Reads a JSON object assigned in a page script, e.g. `var ytInitialPlayerResponse = {...};`
function extractJson(html, name) {
  const at = html.search(new RegExp(`${name}\\s*=\\s*\\{`));
  if (at < 0) return null;
  const open = html.indexOf('{', at);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Live status from a watch page or a channel's /live page.
// -> { state: 'live' | 'upcoming' | 'ended' | 'offline', videoId, title, channel, scheduledAt }
export function readLiveStatus(html) {
  const player = extractJson(html, 'ytInitialPlayerResponse');
  const details = player?.videoDetails;
  // A channel that isn't live serves its channel page (maybe with a trailer that isn't a stream).
  if (!details?.videoId || !(details.isLiveContent || details.isLive || details.isUpcoming)) {
    return { state: 'offline' };
  }
  const broadcast = player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
  const slate = player.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer
    ?.offlineSlate?.liveStreamOfflineSlateRenderer;
  const base = {
    videoId: details.videoId,
    title: details.title ?? null,
    channel: details.author ?? null,
  };
  if (details.isLive || broadcast?.isLiveNow) return { ...base, state: 'live' };
  if (details.isUpcoming || slate?.scheduledStartTime) {
    const scheduledAt = slate?.scheduledStartTime
      ? Number(slate.scheduledStartTime) * 1000
      : (broadcast?.startTimestamp ? Date.parse(broadcast.startTimestamp) : null);
    return { ...base, state: 'upcoming', scheduledAt };
  }
  return { ...base, state: broadcast?.endTimestamp ? 'ended' : 'offline' };
}
