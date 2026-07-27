import type { AudioMeta, ClientMessage, ServerMessage, VideoMeta } from "@speedcrcpy/shared";

/** One encoded video frame handed to a sink; the sink assigns any wire frame id. */
export interface SinkVideoFrame {
  keyframe: boolean;
  /** microseconds, from scrcpy */
  pts: bigint;
  data: Uint8Array;
}

/**
 * Per-viewer transport surface, transport-agnostic. Outbound methods take
 * semantic messages; the concrete sink frames them for its wire — WebSocket
 * channel bytes today (`WsSink`), WebTransport streams later. The backpressure
 * getters feed the congestion controller; inbound client messages and close
 * arrive through the `on*` callbacks.
 *
 * This is the seam the WebTransport migration pivots on: `Viewer` and
 * `ViewerCongestion` speak only to this interface, never to the raw socket.
 */
export interface ViewerSink {
  /** JSON control-plane message (hello / stats / clipboard / …). */
  sendControl(message: ServerMessage): void;
  /** Stream generation metadata (codec / size / quality). Ordered before frames. */
  sendVideoMeta(meta: VideoMeta): void;
  /** Codec config (SPS/PPS). Ordered before frames. */
  sendVideoConf(config: Uint8Array): void;
  /** One encoded video frame. */
  sendVideoFrame(frame: SinkVideoFrame): void;
  /** Audio stream metadata. */
  sendAudioMeta(meta: AudioMeta): void;
  /** One encoded audio packet. */
  sendAudioData(pts: bigint, data: Uint8Array): void;
  /** Drop all queued (unstarted) video frames, e.g. before a stream restart. */
  clearVideo(): void;
  /** Flush state and close the underlying transport. */
  close(): void;

  /** Bytes buffered below the app — the local backpressure signal. */
  readonly bufferedBytes: number;
  /** Cumulative bytes written to the transport — the send-rate EWMA source. */
  readonly sentBytes: number;
  /** Cumulative video frames dropped by queue overflow / clearVideo. */
  readonly droppedFrames: number;

  /** Register the handler for inbound client control messages. */
  onMessage(handler: (message: ClientMessage) => void): void;
  /** Register the handler for transport close / error. */
  onClose(handler: () => void): void;
}
