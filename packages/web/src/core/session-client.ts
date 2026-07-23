import {
  Channel,
  decodeFrame,
  encodeJsonFrame,
  type AudioMeta,
  type ClientMessage,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";

export interface VideoFrameData {
  keyframe: boolean;
  pts: bigint;
  data: Uint8Array;
}

export interface SessionClientEvents {
  onServerMessage(message: ServerMessage): void;
  onVideoMeta(meta: VideoMeta): void;
  onVideoConfig(config: Uint8Array): void;
  onVideoFrame(frame: VideoFrameData): void;
  onAudioMeta(meta: AudioMeta): void;
  onAudioData(pts: bigint, data: Uint8Array): void;
  /** Connection (re)established — server will resend hello/META/config. */
  onConnected(): void;
  /** Connection lost; automatic reconnection is already scheduled. */
  onDisconnected(): void;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;

/**
 * Session WebSocket wrapper: demultiplexes channels, reassembles chunked
 * video frames, and reconnects automatically. Mobile browsers kill the
 * socket within seconds of backgrounding the tab — on return to the
 * foreground we reconnect immediately; in the foreground we retry with
 * exponential backoff forever (the device may come back at any time).
 */
export class SessionClient {
  private ws: WebSocket | undefined;
  private closedByUser = false;
  private retryDelay = RETRY_BASE_MS;
  private retryTimer: number | undefined;

  private pendingFrameId = -1;
  private pendingChunks: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly serial: string,
    private readonly events: SessionClientEvents,
  ) {
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeJsonFrame(message));
    }
  }

  close(): void {
    this.closedByUser = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.detachWs();
    this.ws?.close();
  }

  private connect(): void {
    this.detachWs();
    this.resetReassembly();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws/session/${encodeURIComponent(this.serial)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.retryDelay = RETRY_BASE_MS;
      this.events.onConnected();
    };
    ws.onmessage = (event) => this.handleFrame(new Uint8Array(event.data as ArrayBuffer));
    ws.onclose = () => this.handleClose();
    ws.onerror = () => ws.close();
    this.ws = ws;
  }

  private detachWs(): void {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
    this.ws.onerror = null;
  }

  private handleClose(): void {
    if (this.closedByUser) return;
    this.events.onDisconnected();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.retryTimer !== undefined) return;
    // While hidden, timers are throttled and the browser would kill the new
    // socket anyway — the visibility handler reconnects on return instead.
    if (document.hidden) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  private onVisibility = (): void => {
    if (document.hidden || this.closedByUser) return;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryDelay = RETRY_BASE_MS;
    this.connect();
  };

  private resetReassembly(): void {
    this.pendingFrameId = -1;
    this.pendingChunks = [];
    this.pendingBytes = 0;
  }

  private handleFrame(data: Uint8Array): void {
    const frame = decodeFrame(data);
    switch (frame.channel) {
      case Channel.JSON:
        this.events.onServerMessage(frame.message as ServerMessage);
        break;
      case Channel.VIDEO_META:
        this.events.onVideoMeta(frame.meta as VideoMeta);
        break;
      case Channel.VIDEO_CONF:
        this.events.onVideoConfig(frame.config);
        break;
      case Channel.AUDIO_META:
        this.events.onAudioMeta(frame.meta as AudioMeta);
        break;
      case Channel.AUDIO_DATA:
        this.events.onAudioData(frame.pts, frame.payload);
        break;
      case Channel.VIDEO_CHUNK: {
        const chunk = frame.chunk;
        if (chunk.frameId !== this.pendingFrameId) {
          this.pendingFrameId = chunk.frameId;
          this.pendingChunks = [];
          this.pendingBytes = 0;
        }
        this.pendingChunks.push(chunk.payload);
        this.pendingBytes += chunk.payload.byteLength;

        if (chunk.chunkIndex === chunk.chunkCount - 1) {
          const full = new Uint8Array(this.pendingBytes);
          let offset = 0;
          for (const part of this.pendingChunks) {
            full.set(part, offset);
            offset += part.byteLength;
          }
          this.resetReassembly();
          this.events.onVideoFrame({ keyframe: chunk.keyframe, pts: chunk.pts, data: full });
        }
        break;
      }
    }
  }
}
