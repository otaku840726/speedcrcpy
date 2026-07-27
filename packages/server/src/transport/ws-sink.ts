import {
  Channel,
  chunkVideoFrame,
  decodeFrame,
  encodeAudioDataFrame,
  encodeJsonFrame,
  encodeMetaFrame,
  encodeVideoConfFrame,
  type AudioMeta,
  type ClientMessage,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";
import type { WebSocket } from "ws";
import { SendQueue } from "./send-queue.js";
import type { SinkVideoFrame, ViewerSink } from "./sink.js";

/**
 * WebSocket `ViewerSink`: frames semantic messages into the binary channel
 * protocol and pushes them through the priority `SendQueue`; decodes inbound
 * binary frames back into client messages. All WebSocket-specific wire
 * knowledge lives here.
 */
export class WsSink implements ViewerSink {
  readonly kind = "websocket" as const;
  private readonly queue: SendQueue;
  private frameId = 0;
  private messageHandler: ((message: ClientMessage) => void) | undefined;

  constructor(
    private readonly ws: WebSocket,
    readonly remoteAddress: string | null = null,
  ) {
    this.queue = new SendQueue(ws);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary || !this.messageHandler) return;
      try {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.channel === Channel.JSON) this.messageHandler(frame.message as ClientMessage);
      } catch (error) {
        console.warn(`[ws-sink] bad frame from client: ${(error as Error).message}`);
      }
    });
  }

  sendControl(message: ServerMessage): void {
    this.queue.enqueueControl(encodeJsonFrame(message));
  }

  sendVideoMeta(meta: VideoMeta): void {
    this.queue.enqueueControl(encodeMetaFrame(Channel.VIDEO_META, meta));
  }

  sendVideoConf(config: Uint8Array): void {
    this.queue.enqueueControl(encodeVideoConfFrame(config));
  }

  sendVideoFrame(frame: SinkVideoFrame): void {
    const chunks = chunkVideoFrame(this.frameId++, frame.keyframe, frame.pts, frame.data);
    this.queue.enqueueVideoFrame(chunks);
  }

  sendAudioMeta(meta: AudioMeta): void {
    this.queue.enqueueControl(encodeMetaFrame(Channel.AUDIO_META, meta));
  }

  sendAudioData(pts: bigint, data: Uint8Array): void {
    this.queue.enqueueAudio(encodeAudioDataFrame(pts, data));
  }

  clearVideo(): void {
    this.queue.clearVideo();
  }

  close(): void {
    this.queue.close();
    this.ws.close();
  }

  get bufferedBytes(): number {
    return this.queue.bufferedBytes;
  }

  get sentBytes(): number {
    return this.queue.sentBytes;
  }

  get droppedFrames(): number {
    return this.queue.droppedFrames;
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.ws.on("close", handler);
    this.ws.on("error", handler);
  }
}
