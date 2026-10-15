// Crops the captured tab down to just the video and scales it into a fixed-size,
// letterboxed frame, so the recording is only the stream, full frame, at a constant
// resolution however the page is laid out, scrolled or resized. It runs once per
// captured frame, so it keeps up in the hidden offscreen document.
//
// Tab capture only delivers frames when the page changes. When nothing moves
// (a paused or "starting soon" screen), the last picture is repeated at least
// once a second so the recorder always has video to encode.
//
// The source can be swapped (setSource) without touching the output track, so a
// recorder keeps one continuous file when its input has to be re-captured.

const WHOLE_TAB = { x: 0, y: 0, width: 1, height: 1 };

// Chrome fits the tab into the captured frame keeping its aspect ratio, padding the
// rest with black (centered). Given the tab viewport's aspect, find the tab's area.
function contentBox(fw, fh, aspect) {
  if (!aspect) return { cx: 0, cy: 0, cw: fw, ch: fh };
  if (fw / fh > aspect) {
    const cw = fh * aspect;
    return { cx: (fw - cw) / 2, cy: 0, cw, ch: fh };
  }
  const ch = fw / aspect;
  return { cx: 0, cy: (fh - ch) / 2, cw: fw, ch };
}

const KEEPALIVE_MS = 1000;

const validRegion = (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;

export class VideoCropper {
  constructor(sourceTrack, width, height) {
    this.width = width;
    this.height = height;
    this.region = null;
    this.viewportAspect = null; // kept even when the region is cleared
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    this.track = new MediaStreamTrackGenerator({ kind: 'video' });
    this.writer = this.track.writable.getWriter();
    this.lastTimestamp = -1; // microseconds
    this.lastEmitMs = 0;
    this.stopped = false;
    this.sourceFrames = 0; // real frames received from the source (not keep-alive repeats)
    this.lastSourceFrameMs = performance.now();

    this.setSource(sourceTrack);
    this.keepalive = setInterval(() => {
      if (performance.now() - this.lastEmitMs >= KEEPALIVE_MS) this.emit();
    }, KEEPALIVE_MS / 2);
    this.emit(); // a first (black) frame right away, so recording can start
  }

  // Starts drawing from a new input track; the previous one is let go.
  setSource(track) {
    this.reader?.cancel().catch(() => {});
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    this.lastSourceFrameMs = performance.now(); // give the new input a moment to deliver
    this.pump(this.reader);
  }

  // Ends quietly when its input ends or is replaced; the keep-alive holds the last
  // picture until whoever owns the cropper supplies a new source or stops it.
  async pump(reader) {
    while (!this.stopped && reader === this.reader) {
      const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      this.sourceFrames++;
      this.lastSourceFrameMs = performance.now();
      try {
        this.draw(frame);
        this.emit();
      } catch {
        // Drop this frame rather than end the recording.
      } finally {
        frame.close();
      }
    }
  }

  // Writes the canvas out as the next frame. Frames are emitted as they happen, so
  // one wall clock stamps them all (capture timestamps use an unrelated origin,
  // which would open a huge gap after the first keep-alive frame). Must increase.
  emit() {
    if (this.stopped) return;
    this.lastEmitMs = performance.now();
    const ts = Math.max(Math.round(this.lastEmitMs * 1000), this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const frame = new VideoFrame(this.canvas, { timestamp: ts });
    this.writer.write(frame).catch(() => frame.close());
  }

  // `region` is the video's rectangle as fractions of the tab's viewport (it may
  // extend past 0..1 when partly scrolled out of view), plus the viewport's aspect
  // ratio; null records the whole tab.
  setRegion(region) {
    this.region = validRegion(region) ? region : null;
    if (Number.isFinite(region?.viewportAspect) && region.viewportAspect > 0) this.viewportAspect = region.viewportAspect;
  }

  // Last resort when the input track delivers nothing although the video plays:
  // copy the <video> element's current picture directly, at the given rate.
  pullFrom(element, fps) {
    if (this.pulling) return;
    this.pullStartFrames = this.sourceFrames;
    this.pulling = setInterval(() => {
      if (!element.videoWidth) return;
      try {
        this.draw(element);
        this.emit();
      } catch {
        // Try again on the next tick.
      }
    }, 1000 / fps);
  }

  // True once the input track has delivered a good second of frames since pulling began.
  get inputRecovered() {
    return this.sourceFrames - this.pullStartFrames >= 25;
  }

  stopPulling() {
    clearInterval(this.pulling);
    this.pulling = null;
  }

  // `source` is a VideoFrame from the input track, or the <video> element itself.
  draw(source) {
    const { ctx, width: W, height: H } = this;
    const fw = source.displayWidth ?? source.videoWidth;
    const fh = source.displayHeight ?? source.videoHeight;
    const r = this.region ?? WHOLE_TAB;
    const { cx, cy, cw, ch } = contentBox(fw, fh, this.viewportAspect);

    // The whole video, in captured-frame pixels, and where it lands in the output.
    const vx = cx + r.x * cw;
    const vy = cy + r.y * ch;
    const vw = r.width * cw;
    const vh = r.height * ch;
    const scale = Math.min(W / vw, H / vh);
    const ox = (W - vw * scale) / 2;
    const oy = (H - vh * scale) / 2;

    // Only the part of the video that is actually on screen can be drawn.
    const sx = Math.max(cx, vx);
    const sy = Math.max(cy, vy);
    const ex = Math.min(cx + cw, vx + vw);
    const ey = Math.min(cy + ch, vy + vh);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (ex - sx >= 1 && ey - sy >= 1) {
      ctx.drawImage(source, sx, sy, ex - sx, ey - sy,
        ox + (sx - vx) * scale, oy + (sy - vy) * scale, (ex - sx) * scale, (ey - sy) * scale);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.keepalive);
    this.stopPulling();
    this.reader?.cancel().catch(() => {});
    this.writer.close().catch(() => {});
    this.track.stop();
  }
}
