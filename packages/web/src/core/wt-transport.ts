import {
  Channel,
  StreamFrameReader,
  WtStreamType,
  decodeFrame,
  decodeWtVideoBody,
  encodeJsonFrame,
  encodeStreamFrame,
  type AudioMeta,
  type ClientMessage,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";
import type { SessionClientEvents, SessionTransport } from "./session-client";

export interface WtInfo {
  enabled: boolean;
  port: number;
  certHash: string | null;
  token: string | null;
}

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * WebTransport (HTTP/3) session transport — the QUIC counterpart to
 * `WsTransport`. Control rides one bidirectional stream (attach frame first,
 * then length-prefixed messages both ways); the server pushes audio on one
 * unidirectional stream and every video frame on its own, so a lost packet
 * only stalls that one frame. Reconnects like the WS transport; a failure on
 * the very first connect calls `onInitialFailure` so the caller can fall back
 * to WebSocket.
 */
export class WtTransport implements SessionTransport {
  private wt: WebTransport | undefined;
  private controlWriter: WritableStreamDefaultWriter<Uint8Array> | undefined;
  private controlReadable: ReadableStream<Uint8Array> | undefined;
  private closedByUser = false;
  private everConnected = false;
  private retryDelay = RETRY_BASE_MS;
  private retryTimer: number | undefined;

  constructor(
    private readonly serial: string,
    private readonly events: SessionClientEvents,
    private readonly info: WtInfo,
    private readonly onInitialFailure: () => void,
  ) {
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.connect();
  }

  send(message: ClientMessage): void {
    this.writeControl(encodeJsonFrame(message));
  }

  close(): void {
    this.closedByUser = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
    this.controlWriter = undefined;
    try {
      this.wt?.close();
    } catch {
      /* already closed */
    }
  }

  private async connect(): Promise<void> {
    this.controlWriter = undefined;
    const url = `https://${location.hostname}:${this.info.port}/wt/session`;
    const options: WebTransportOptions = this.info.certHash
      ? { serverCertificateHashes: [{ algorithm: "sha-256", value: base64ToBytes(this.info.certHash) as BufferSource }] }
      : {};

    let wt: WebTransport;
    try {
      wt = new WebTransport(url, options);
      this.wt = wt;
      await wt.ready;
      const control = await wt.createBidirectionalStream();
      this.controlWriter = control.writable.getWriter();
      this.controlReadable = control.readable;
      // Attach handshake: first control frame is plain JSON {serial, token}.
      this.writeRaw(new TextEncoder().encode(JSON.stringify({ serial: this.serial, token: this.info.token ?? "" })));
    } catch {
      if (!this.everConnected) {
        this.onInitialFailure();
        return;
      }
      this.scheduleReconnect();
      return;
    }

    this.everConnected = true;
    this.retryDelay = RETRY_BASE_MS;
    this.events.onConnected();

    void this.readControl();
    void this.readUniStreams(wt);
    void wt.closed.then(() => this.handleClose()).catch(() => this.handleClose());
  }

  private writeControl(frame: Uint8Array): void {
    this.writeRaw(frame);
  }

  private writeRaw(frame: Uint8Array): void {
    const writer = this.controlWriter;
    if (!writer) return;
    void writer.write(encodeStreamFrame(frame)).catch(() => {});
  }

  private async readControl(): Promise<void> {
    const readable = this.controlReadable;
    if (!readable) return;
    const reader = readable.getReader();
    const framer = new StreamFrameReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const frame of framer.push(value)) this.dispatchServerFrame(frame);
      }
    } catch {
      /* torn down */
    }
  }

  private dispatchServerFrame(frame: Uint8Array): void {
    try {
      const decoded = decodeFrame(frame);
      switch (decoded.channel) {
        case Channel.JSON:
          this.events.onServerMessage(decoded.message as ServerMessage);
          break;
        case Channel.VIDEO_META:
          this.events.onVideoMeta(decoded.meta as VideoMeta);
          break;
        case Channel.VIDEO_CONF:
          this.events.onVideoConfig(decoded.config);
          break;
        case Channel.AUDIO_META:
          this.events.onAudioMeta(decoded.meta as AudioMeta);
          break;
        case Channel.AUDIO_DATA:
          this.events.onAudioData(decoded.pts, decoded.payload);
          break;
      }
    } catch {
      /* ignore malformed frame */
    }
  }

  private async readUniStreams(wt: WebTransport): Promise<void> {
    const reader = (wt.incomingUnidirectionalStreams as ReadableStream<ReadableStream<Uint8Array>>).getReader();
    try {
      for (;;) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        if (stream) void this.handleUniStream(stream);
      }
    } catch {
      /* torn down */
    }
  }

  private async handleUniStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    let type = -1;
    let framer: StreamFrameReader | undefined;
    const videoChunks: Uint8Array[] = [];
    let videoBytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        let bytes = value;
        if (type === -1) {
          type = bytes[0]!;
          bytes = bytes.subarray(1);
          if (type === WtStreamType.AUDIO) framer = new StreamFrameReader();
        }
        if (type === WtStreamType.AUDIO && framer) {
          for (const frame of framer.push(bytes)) this.dispatchServerFrame(frame);
        } else if (type === WtStreamType.VIDEO && bytes.byteLength > 0) {
          videoChunks.push(bytes);
          videoBytes += bytes.byteLength;
        }
      }
    } catch {
      return; // stream reset (e.g. stale frame dropped) — just skip it
    }
    if (type === WtStreamType.VIDEO && videoBytes > 0) {
      const body = new Uint8Array(videoBytes);
      let offset = 0;
      for (const part of videoChunks) {
        body.set(part, offset);
        offset += part.byteLength;
      }
      const frame = decodeWtVideoBody(body);
      this.events.onVideoFrame({ keyframe: frame.keyframe, pts: frame.pts, data: frame.data });
    }
  }

  private handleClose(): void {
    if (this.closedByUser) return;
    this.controlWriter = undefined;
    this.controlReadable = undefined;
    this.events.onDisconnected();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.retryTimer !== undefined || document.hidden) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  private onVisibility = (): void => {
    if (document.hidden || this.closedByUser) return;
    if (this.wt && this.controlWriter) return; // still connected
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.retryDelay = RETRY_BASE_MS;
    void this.connect();
  };
}
