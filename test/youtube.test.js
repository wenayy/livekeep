import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchInput, statusUrl, readLiveStatus } from '../extension/lib/youtube.js';

test('understands the ways people paste channels and streams', () => {
  const cases = {
    '@LofiGirl': { kind: 'channel', channelUrl: 'https://www.youtube.com/@LofiGirl' },
    '@LofiGirl/live': { kind: 'channel', channelUrl: 'https://www.youtube.com/@LofiGirl' },
    'https://www.youtube.com/@LofiGirl/streams': { kind: 'channel', channelUrl: 'https://www.youtube.com/@LofiGirl' },
    'youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow': { kind: 'channel', channelUrl: 'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow' },
    'https://www.youtube.com/watch?v=1-LpQekNa9g&t=3': { kind: 'video', videoId: '1-LpQekNa9g' },
    'https://m.youtube.com/live/1-LpQekNa9g?si=abc': { kind: 'video', videoId: '1-LpQekNa9g' },
    'https://youtu.be/1-LpQekNa9g': { kind: 'video', videoId: '1-LpQekNa9g' },
  };
  for (const [input, expected] of Object.entries(cases)) {
    const got = parseWatchInput(input);
    for (const [k, v] of Object.entries(expected)) assert.equal(got?.[k], v, `${input} -> ${k}`);
  }
  for (const bad of ['', 'hello', 'https://vimeo.com/123', 'https://www.youtube.com/']) assert.equal(parseWatchInput(bad), null, bad);
  assert.equal(statusUrl(parseWatchInput('@LofiGirl')), 'https://www.youtube.com/@LofiGirl/live');
});

const page = (player) => `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = 1;</script></html>`;

test('detects a live stream', () => {
  const s = readLiveStatus(page({
    videoDetails: { videoId: 'abcdefghijk', title: 'Live now }{ "tricky"', author: 'Chan', isLive: true, isLiveContent: true },
  }));
  assert.deepEqual(s, { state: 'live', videoId: 'abcdefghijk', title: 'Live now }{ "tricky"', channel: 'Chan' });
});

test('detects a scheduled stream and its start time', () => {
  const s = readLiveStatus(page({
    videoDetails: { videoId: 'abcdefghijk', isUpcoming: true, isLiveContent: true },
    playabilityStatus: { liveStreamability: { liveStreamabilityRenderer: { offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: '1800000000' } } } } },
  }));
  assert.equal(s.state, 'upcoming');
  assert.equal(s.scheduledAt, 1_800_000_000_000);
});

test('an ended stream, a normal video or a channel page is not live', () => {
  assert.equal(readLiveStatus(page({
    videoDetails: { videoId: 'abcdefghijk', isLiveContent: true },
    microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: false, endTimestamp: '2026-01-01T00:00:00Z' } } },
  })).state, 'ended');
  assert.equal(readLiveStatus(page({ videoDetails: { videoId: 'abcdefghijk', isLiveContent: false } })).state, 'offline');
  assert.equal(readLiveStatus('<html>channel page without a player</html>').state, 'offline');
});
