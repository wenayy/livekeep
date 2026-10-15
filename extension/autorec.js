// Records a stream that LiveKeep opened by itself for the watch list. Chrome only
// allows tab capture after a click, so this records the player's own video and audio
// instead (video.captureStream()): just the stream, at full quality, no page or
// controls, and it keeps working while the tab is hidden or minimized. The picture
// goes through the same cropper to get a fixed output size, and the recording is
// streamed to the offscreen document part by part, chunk by chunk.
//
// Runs in the YouTube tab's content-script world (imported by content.js).

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
const PLAY_TIMEOUT_MS = 3 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const player = () => document.querySelector('#movie_player');
const videoEl = () => document.querySelector('#movie_player video');
const adShowing = () => !!player()?.classList.contains('ad-showing');

function toSW(msg) {
  return chrome.runtime.sendMessage({ to: 'sw', ...msg }).catch(() => null);
}

const dataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// Messages to the recorder, strictly one at a time and in order, retried if the
// offscreen document is briefly unavailable. A `blob` is sent as a data: URL,
// since extension messages carry only JSON.
let queue = Promise.resolve();
function toRecorder({ blob, ...msg }) {
  const attempt = async () => {
    // Untyped on purpose: the recorder's type ("video/mp4;codecs=avc1,mp4a.40.2") has a
    // comma, which would cut the data: URL short and corrupt the bytes.
    if (blob) msg.data = await dataUrl(new Blob([blob]));
    for (let i = 0; ; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ to: 'offscreen', ...msg });
        if (res?.ok) return res;
        throw new Error(res?.error || 'no response');
      } catch (e) {
        if (i >= 5) throw e;
        await toSW({ type: 'ensureRecorder' });
        await sleep(1000 * (i + 1));
      }
    }
  };
  const result = queue.then(attempt);
  queue = result.catch(() => {});
  return result;
}

// "Video paused. Continue watching?" and similar prompts would stop the recording,
// and a skippable ad would delay it; press what a viewer would press. Ads are never
// recorded either way: recording pauses while one is showing.
const PROMPT_BUTTONS = [
  'yt-confirm-dialog-renderer #confirm-button button',
  'yt-confirm-dialog-renderer #confirm-button',
  '.ytp-skip-ad-button',
  '.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button',
].join(', ');
function dismissPrompts() {
  for (const button of document.querySelectorAll(PROMPT_BUTTONS)) {
    if (button.checkVisibility?.()) button.click();
  }
}

// Gets the video playing. Unmuted if Chrome allows it, because Chrome pauses muted
// videos in hidden tabs; the tab itself is muted, so nothing is heard either way.
async function startPlayback(recordingId) {
  const started = Date.now();
  let mutedFallback = false;
  let askedToShow = false;
  while (Date.now() - started < PLAY_TIMEOUT_MS) {
    dismissPrompts();
    const v = videoEl();
    // Chrome doesn't load video in a window it considers never shown (e.g. opened behind others).
    if (!askedToShow && Date.now() - started > 20_000 && (!v || v.readyState === 0)) {
      askedToShow = true;
      toSW({ type: 'autoNeedsShow', recordingId });
    }
    if (v && !adShowing()) {
      if (v.paused) {
        v.muted = false;
        try {
          await v.play();
        } catch {
          v.muted = true;
          mutedFallback = true;
          await v.play().catch(() => {});
        }
      }
      if (!v.paused && v.readyState >= 3) return { video: v, mutedFallback };
    }
    await sleep(1000);
  }
  throw new Error('The stream never started playing');
}

// The recording's audio comes out of a Web Audio graph whose input can be replaced,
// so a fresh capture of the player can be plugged in without starting a new file.
// If Chrome won't run audio here (no autoplay with sound), the captured track is
// recorded directly instead, and replacing it means starting a new part.
//
// A player feeds only one audio capture at a time: a newer captureStream() takes the
// audio over, and stopping the older capture later cuts the newer one off too. So the
// current capture is released completely before the player is captured again.
class AudioBridge {
  async init(track) {
    this.ctx = new AudioContext();
    await Promise.race([this.ctx.resume().catch(() => {}), sleep(500)]);
    this.swappable = this.ctx.state === 'running';
    if (this.swappable) this.dest = this.ctx.createMediaStreamDestination();
    this.setSource(track);
    this.track = this.swappable ? this.dest.stream.getAudioTracks()[0] : track;
    return this;
  }

  setSource(track) {
    this.input = track;
    if (this.swappable) {
      this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.source.connect(this.dest);
    }
    // Watch whether sound is actually arriving (on a clone, so the recording isn't touched).
    this.lastPacketMs = performance.now();
    this.watch = track.clone();
    const reader = new MediaStreamTrackProcessor({ track: this.watch }).readable.getReader();
    this.reader = reader;
    (async () => {
      while (this.reader === reader) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        this.lastPacketMs = performance.now();
        value.close();
      }
    })();
  }

  get msSincePacket() {
    return performance.now() - this.lastPacketMs;
  }

  // Lets go of the current capture entirely (every track of it), freeing the player's audio.
  release() {
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.source?.disconnect();
    this.source = null;
    this.input?.stop();
    this.watch?.stop();
    this.input = null;
    this.watch = null;
  }

  close() {
    this.release();
    this.ctx?.close().catch(() => {});
  }
}

// If the video is playing but no frames or sound reached the recording for this long,
// the capture went stale (YouTube reloaded the video inside the same player, e.g. on
// fullscreen or a quality change) and is replaced with a fresh one.
const STALE_MS = 2500;

export class AutoRecorder {
  constructor(job) {
    this.job = job;
    this.stopping = false;
    this.recaptures = 0;
    this.mimeType = MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
    this.container = this.mimeType.split(';')[0];
    this.ext = this.container === 'video/mp4' ? 'mp4' : 'webm';
  }

  async start() {
    const { mutedFallback } = await startPlayback(this.job.recording.id);
    await this.startPart();
    toSW({ type: 'autoStarted', recordingId: this.job.recording.id, mutedFallback });
    this.watchdog();
  }

  // One MediaRecorder per part. A new part starts after an ad, at the user's split
  // interval, or if the audio has to be re-captured and can't be swapped in place.
  async startPart() {
    const element = videoEl();
    const stream = element.captureStream();
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (!videoTrack) throw new Error('The player has no video to record');
    const { quality } = this.job;
    const cropper = new VideoCropper(videoTrack, quality.width, quality.height);
    const audio = audioTrack ? await new AudioBridge().init(audioTrack) : null;
    const recorder = new MediaRecorder(new MediaStream([cropper.track, audio?.track].filter(Boolean)), {
      mimeType: this.mimeType,
      videoBitsPerSecond: quality.videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
      videoKeyFrameIntervalDuration: 2000,
    });
    const { partId } = await toRecorder({
      type: 'pagePart',
      recording: this.job.recording,
      mimeType: this.container,
      ext: this.ext,
      split: this.job.partMinutes > 0,
    });
    if (this.stopping) { // Stop arrived while this part was being set up
      cropper.stop();
      audio?.close();
      videoTrack.stop();
      await toRecorder({ type: 'pagePartClosed', partId }).catch(() => {});
      return;
    }
    recorder.ondataavailable = ({ data }) => {
      if (data.size) toRecorder({ type: 'pageChunk', partId, blob: data }).catch(() => {});
    };
    const closed = new Promise((resolve) => {
      recorder.onstop = () => {
        cropper.stop();
        audio?.close();
        resolve(toRecorder({ type: 'pagePartClosed', partId }).catch(() => {}));
      };
    });
    recorder.start(TIMESLICE_MS);
    this.part = { recorder, closed, cropper, audio, element, videoTrack, startedAt: Date.now() };
  }

  async endPart() {
    const part = this.part;
    this.part = null;
    if (!part) return;
    if (part.recorder.state !== 'inactive') part.recorder.stop();
    await part.closed;
    part.videoTrack.stop();
  }

  // Takes a fresh capture of the player and feeds it into the current part.
  // Returns false if that isn't possible in place and a new part is needed.
  recapture(part, element) {
    part.recapturedAt = performance.now();
    if (part.audio && !part.audio.swappable) return false;
    part.audio?.release(); // before capturing again: one audio capture per player
    const stream = element.captureStream();
    const [videoTrack] = stream.getVideoTracks();
    const [audioTrack] = stream.getAudioTracks();
    if (audioTrack) {
      if (part.audio) part.audio.setSource(audioTrack);
      else audioTrack.stop(); // this part has no audio track to feed
    }
    if (videoTrack?.readyState === 'live') {
      try {
        part.cropper.setSource(videoTrack);
        part.videoTrack.stop();
        part.videoTrack = videoTrack;
      } catch {
        videoTrack.stop();
      }
    } else {
      videoTrack?.stop();
    }
    part.element = element;
    this.recaptures++;
    return true;
  }

  // Makes sure frames and sound from the playing video keep reaching the recording.
  async heal(part, v) {
    const now = performance.now();
    const { cropper } = part;
    if (cropper.pulling) {
      if (cropper.inputRecovered) cropper.stopPulling(); // captured frames are back
      else if (now - part.recapturedAt > 10_000) this.recapture(part, v); // keep trying now and then
      return;
    }
    const videoStale = now - cropper.lastSourceFrameMs > STALE_MS;
    const audioStale = !!part.audio && part.audio.msSincePacket > STALE_MS;
    if (!videoStale && !audioStale && v === part.element) return;
    // Sound alone gone quiet: retry now and then rather than every second.
    if (!videoStale && v === part.element && now - (part.recapturedAt ?? -Infinity) < 4 * STALE_MS) return;
    if (videoStale && v === part.element && now - (part.recapturedAt ?? -Infinity) < 3 * STALE_MS) {
      // A fresh capture didn't bring frames back either: copy them from the player.
      cropper.pullFrom(v, this.job.quality.frameRate);
      return;
    }
    if (!this.recapture(part, v)) {
      await this.endPart();
      await this.startPart();
    }
  }

  // Once a second: keep the stream playing, skip what a viewer would skip, and make
  // sure frames and sound are still reaching the recording.
  async watchdog() {
    let lastTime = null;
    while (!this.stopping) {
      await sleep(1000);
      if (this.stopping) break;
      dismissPrompts();
      const v = videoEl();
      if (v?.paused && !v.ended && !adShowing()) v.play().catch(() => {});
      const advancing = !!v && !v.paused && v.readyState >= 3 && lastTime !== null && v.currentTime !== lastTime;
      lastTime = v?.currentTime ?? null;
      const part = this.part;
      const splitDue = this.job.partMinutes > 0 && part && Date.now() - part.startedAt >= this.job.partMinutes * 60_000;
      try {
        if (adShowing()) {
          await this.endPart(); // don't record ads; resume when the stream is back
        } else if (!part || splitDue) {
          await this.endPart();
          if (videoEl()?.readyState >= 2) await this.startPart();
        } else if (advancing) {
          await this.heal(part, v);
        }
      } catch (e) {
        toSW({ type: 'autoProblem', recordingId: this.job.recording.id, message: e.message });
      }
    }
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    await this.endPart();
    await queue;
  }
}
