import type { WebSocket } from "ws";

/** Stop pumping into the socket above this to keep kernel queues shallow. */
const LOW_WATER_BYTES = 64 * 1024;
/** Re-check drain interval while the socket is backpressured. */
const RETRY_MS = 4;
/** Control messages held for a socket that is not draining. Generous — this is
 * a ceiling against a dead peer, not a policy for a slow one. */
const MAX_QUEUED_CONTROL = 256;

/**
 * Priority send queue over one WebSocket: control > audio > video.
 * Video frames are pre-chunked so control/audio messages interleave between
 * chunks of a large frame — bounding priority inversion on the single TCP
 * connection. When the video queue overflows, whole (unstarted) frames are
 * dropped oldest-first; the frame currently being transmitted is never
 * abandoned mid-way.
 */
export class SendQueue {
  droppedFrames = 0;
  sentBytes = 0;

  private readonly control: Uint8Array[] = [];
  private readonly audio: Uint8Array[] = [];
  private readonly video: Uint8Array[][] = [];
  private currentFrame: Uint8Array[] | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private maxQueuedVideoFrames = 3,
    private readonly maxQueuedAudio = 32,
  ) {
    ws.on("close", () => this.close());
  }

  setMaxQueuedVideoFrames(value: number): void {
    this.maxQueuedVideoFrames = value;
  }

  get queuedVideoFrames(): number {
    return this.video.length + (this.currentFrame?.length ? 1 : 0);
  }

  get bufferedBytes(): number {
    return this.ws.bufferedAmount;
  }

  enqueueControl(frame: Uint8Array): void {
    if (this.closed) return;
    this.control.push(frame);
    // Audio and video have always been bounded; this was not. A socket that
    // stops draining without ever closing — a client the OS froze, a phone that
    // left the network — goes on being handed stats and pings once a second for
    // as long as the process lives. Oldest-first: a client that far behind will
    // never catch up on them, and the recent ones are the ones worth having.
    while (this.control.length > MAX_QUEUED_CONTROL) this.control.shift();
    this.pump();
  }

  enqueueAudio(frame: Uint8Array): void {
    if (this.closed) return;
    this.audio.push(frame);
    while (this.audio.length > this.maxQueuedAudio) this.audio.shift();
    this.pump();
  }

  /** One video frame, already split into chunk frames. */
  enqueueVideoFrame(chunks: Uint8Array[]): void {
    if (this.closed) return;
    this.video.push(chunks);
    while (this.video.length > this.maxQueuedVideoFrames) {
      this.video.shift();
      this.droppedFrames++;
    }
    this.pump();
  }

  /** Drop all queued (unstarted) video frames, e.g. before a stream restart. */
  clearVideo(): void {
    this.droppedFrames += this.video.length;
    this.video.length = 0;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.control.length = 0;
    this.audio.length = 0;
    this.video.length = 0;
    this.currentFrame = undefined;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.ws.readyState === this.ws.OPEN && this.ws.bufferedAmount < LOW_WATER_BYTES) {
      const frame = this.next();
      if (!frame) return;
      this.ws.send(frame);
      this.sentBytes += frame.byteLength;
    }
    if (this.hasData()) this.scheduleRetry();
  }

  private next(): Uint8Array | undefined {
    const control = this.control.shift();
    if (control) return control;
    const audio = this.audio.shift();
    if (audio) return audio;

    if (!this.currentFrame?.length) {
      this.currentFrame = this.video.shift();
    }
    return this.currentFrame?.shift();
  }

  private hasData(): boolean {
    return (
      this.control.length > 0 ||
      this.audio.length > 0 ||
      this.video.length > 0 ||
      (this.currentFrame?.length ?? 0) > 0
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, RETRY_MS);
  }
}
