import {
  Channel,
  StreamFrameReader,
  WtStreamType,
  decodeFrame,
  encodeAudioDataFrame,
  encodeJsonFrame,
  encodeMetaFrame,
  encodeStreamFrame,
  encodeVideoConfFrame,
  encodeWtVideoStream,
  type AudioMeta,
  type ClientMessage,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";
import type { SinkVideoFrame, ViewerSink } from "./sink.js";

// --- minimal structural types over the @fails-components WebTransport objects,
// so we don't fight lib.dom's WebTransport typings. ---
interface WtWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
interface WtWritable {
  getWriter(): WtWriter;
}
interface WtReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
}
interface WtReadable {
  getReader(): WtReader;
}
export interface WtBidiStream {
  readable: WtReadable;
  writable: WtWritable;
}
export interface WtSession {
  readonly closed: Promise<unknown>;
  close(info?: { closeCode?: number; reason?: string }): void;
  createUnidirectionalStream(opts?: { sendOrder?: number }): Promise<WtWritable>;
}

/** Audio outranks every video frame; control rides the client-opened bidi. */
const AUDIO_SEND_ORDER = 1e15;
/** Cap concurrent in-flight video streams; abort the oldest beyond this. */
const MAX_ACTIVE_VIDEO = 3;

interface VideoEntry {
  id: number;
  bytes: number;
  writer?: WtWriter;
  settled: boolean;
}

/**
 * WebTransport `ViewerSink`. Maps the channel model onto QUIC streams:
 * - **control** → the client-opened reliable bidi stream (JSON / VIDEO_META /
 *   VIDEO_CONF out; ClientMessages in), length-prefixed.
 * - **audio** → one server-opened reliable uni stream, length-prefixed.
 * - **video** → one uni stream per frame (lowest `sendOrder`), so a lost frame
 *   only stalls its own stream, and stale frames are reset rather than retried.
 *
 * The first inbound control frame is the attach `{serial, token}`, delivered to
 * `onAttach`; everything after is a `ClientMessage` for the Viewer.
 */
export class WtSink implements ViewerSink {
  droppedFrames = 0;
  sentBytes = 0;

  private readonly controlWriter: WtWriter;
  private audioStreamPromise: Promise<WtWriter> | undefined;
  private videoFrameId = 0;
  private readonly activeVideo: VideoEntry[] = [];

  private attached = false;
  private messageHandler: ((message: ClientMessage) => void) | undefined;
  private readonly pendingClientFrames: Uint8Array[] = [];
  private closeHandler: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly session: WtSession,
    control: WtBidiStream,
    private readonly onAttach: (serial: string, token: string) => void,
  ) {
    this.controlWriter = control.writable.getWriter();
    void this.readControl(control.readable);
    void this.session.closed.then(() => this.handleClose()).catch(() => this.handleClose());
  }

  // ---- outbound ----

  sendControl(message: ServerMessage): void {
    this.writeControl(encodeJsonFrame(message));
  }

  sendVideoMeta(meta: VideoMeta): void {
    this.writeControl(encodeMetaFrame(Channel.VIDEO_META, meta));
  }

  sendVideoConf(config: Uint8Array): void {
    this.writeControl(encodeVideoConfFrame(config));
  }

  sendAudioMeta(meta: AudioMeta): void {
    this.writeAudio(encodeMetaFrame(Channel.AUDIO_META, meta));
  }

  sendAudioData(pts: bigint, data: Uint8Array): void {
    this.writeAudio(encodeAudioDataFrame(pts, data));
  }

  sendVideoFrame(frame: SinkVideoFrame): void {
    if (this.closed) return;
    const id = this.videoFrameId++;
    const bytes = encodeWtVideoStream(id, frame.keyframe, frame.pts, frame.data);
    const entry: VideoEntry = { id, bytes: bytes.byteLength, settled: false };
    this.activeVideo.push(entry);
    this.capActiveVideo();

    void this.session
      .createUnidirectionalStream({ sendOrder: id })
      .then(async (stream) => {
        if (entry.settled) return; // capped/cleared before the stream opened
        const writer = stream.getWriter();
        entry.writer = writer;
        await writer.write(bytes);
        this.sentBytes += bytes.byteLength;
        await writer.close();
        this.settle(entry, false);
      })
      .catch(() => this.settle(entry, true));
  }

  clearVideo(): void {
    for (const entry of this.activeVideo.slice()) this.abort(entry);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearVideo();
    try {
      void this.controlWriter.close().catch(() => {});
    } catch {
      /* already closing */
    }
    try {
      this.session.close();
    } catch {
      /* already closed */
    }
  }

  // ---- backpressure / stats ----

  /** Best-effort local backlog: bytes of video frames still in flight. */
  get bufferedBytes(): number {
    let total = 0;
    for (const entry of this.activeVideo) if (!entry.settled) total += entry.bytes;
    return total;
  }

  // ---- inbound / lifecycle ----

  onMessage(handler: (message: ClientMessage) => void): void {
    this.messageHandler = handler;
    for (const frame of this.pendingClientFrames.splice(0)) this.dispatchClientFrame(frame);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) handler();
  }

  // ---- internals ----

  private writeControl(frame: Uint8Array): void {
    if (this.closed) return;
    const wire = encodeStreamFrame(frame);
    void this.controlWriter.write(wire).then(
      () => {
        this.sentBytes += wire.byteLength;
      },
      () => {},
    );
  }

  private writeAudio(frame: Uint8Array): void {
    if (this.closed) return;
    const wire = encodeStreamFrame(frame);
    if (!this.audioStreamPromise) {
      this.audioStreamPromise = this.session.createUnidirectionalStream({ sendOrder: AUDIO_SEND_ORDER }).then(
        async (stream) => {
          const writer = stream.getWriter();
          await writer.write(new Uint8Array([WtStreamType.AUDIO]));
          return writer;
        },
      );
    }
    void this.audioStreamPromise.then(
      async (writer) => {
        await writer.write(wire);
        this.sentBytes += wire.byteLength;
      },
      () => {},
    );
  }

  private capActiveVideo(): void {
    while (this.activeVideo.length > MAX_ACTIVE_VIDEO) {
      const oldest = this.activeVideo[0]!;
      this.abort(oldest);
    }
  }

  private abort(entry: VideoEntry): void {
    if (entry.settled) return;
    if (entry.writer) void entry.writer.abort().catch(() => {});
    this.settle(entry, true);
  }

  private settle(entry: VideoEntry, dropped: boolean): void {
    if (entry.settled) return;
    entry.settled = true;
    if (dropped) this.droppedFrames++;
    const idx = this.activeVideo.indexOf(entry);
    if (idx >= 0) this.activeVideo.splice(idx, 1);
  }

  private async readControl(readable: WtReadable): Promise<void> {
    const reader = readable.getReader();
    const framer = new StreamFrameReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const frame of framer.push(value)) this.onControlFrame(frame);
      }
    } catch {
      /* stream torn down */
    }
    this.handleClose();
  }

  private onControlFrame(frame: Uint8Array): void {
    if (!this.attached) {
      this.attached = true;
      try {
        const { serial, token } = JSON.parse(new TextDecoder().decode(frame)) as { serial: string; token: string };
        this.onAttach(serial, token);
      } catch {
        this.close();
      }
      return;
    }
    if (this.messageHandler) this.dispatchClientFrame(frame);
    else this.pendingClientFrames.push(frame);
  }

  private dispatchClientFrame(frame: Uint8Array): void {
    try {
      const decoded = decodeFrame(frame);
      if (decoded.channel === Channel.JSON) this.messageHandler?.(decoded.message as ClientMessage);
    } catch (error) {
      console.warn(`[wt-sink] bad client frame: ${(error as Error).message}`);
    }
  }

  private handleClose(): void {
    if (this.closed) {
      this.closeHandler?.();
      return;
    }
    this.closed = true;
    this.closeHandler?.();
  }
}
