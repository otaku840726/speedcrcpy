import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, type AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { ReadableStream } from "@yume-chan/stream-extra";
import { makeVideoOptions, type VideoSessionConfig } from "./options.js";
import { pushServer, removeServer } from "./server-binary.js";

export interface VideoPipelineEvents {
  onPacket: (packet: ScrcpyMediaStreamPacket) => void;
  onSizeChanged: (size: { width: number; height: number }) => void;
  onExit: () => void;
}

/**
 * The restartable video-only scrcpy instance. Input/audio/clipboard live in
 * the persistent DeviceSession, so quality switches (= new VideoPipeline)
 * never interrupt them.
 */
export class VideoPipeline {
  readonly codec: "h264" | "h265";
  width: number;
  height: number;

  /** Latest configuration (SPS/PPS) packet — every new viewer needs it first. */
  currentConfig: Uint8Array | undefined;

  private readonly packetListeners = new Set<VideoPipelineEvents["onPacket"]>();
  private readonly sizeListeners = new Set<VideoPipelineEvents["onSizeChanged"]>();
  private readonly exitListeners = new Set<VideoPipelineEvents["onExit"]>();
  private closed = false;

  private constructor(
    private readonly client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>>,
    readonly config: VideoSessionConfig,
    codec: ScrcpyVideoCodecId,
    width: number,
    height: number,
  ) {
    this.codec = codec === ScrcpyVideoCodecId.H265 ? "h265" : "h264";
    this.width = width;
    this.height = height;
  }

  /**
   * `initialListener`, when given, is registered before the first packet is
   * consumed — guaranteeing the caller sees the very first config + keyframe
   * (needed for make-before-break quality switches).
   */
  static async start(
    adb: Adb,
    config: VideoSessionConfig,
    initialListener?: VideoPipelineEvents["onPacket"],
  ): Promise<VideoPipeline> {
    // Unique jar per instance — see pushServer for the unlink race this avoids.
    const serverPath = await pushServer(adb);
    let client;
    try {
      client = await AdbScrcpyClient.start(adb, serverPath, makeVideoOptions(config));
    } catch (error) {
      void removeServer(adb, serverPath);
      throw error;
    }

    const video = await client.videoStream;
    const pipeline = new VideoPipeline(client, config, video.metadata.codec, video.width, video.height);
    if (initialListener) pipeline.packetListeners.add(initialListener);

    video.sizeChanged((size) => {
      pipeline.width = size.width;
      pipeline.height = size.height;
      for (const listener of pipeline.sizeListeners) listener(size);
    });

    void pipeline.consumeVideo(video.stream);
    void pipeline.consumeOutput();
    void client.exited.catch(() => {}).then(() => pipeline.handleExit());

    return pipeline;
  }

  onPacket(listener: VideoPipelineEvents["onPacket"]): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  removePacketListener(listener: VideoPipelineEvents["onPacket"]): void {
    this.packetListeners.delete(listener);
  }

  onSizeChanged(listener: VideoPipelineEvents["onSizeChanged"]): () => void {
    this.sizeListeners.add(listener);
    return () => this.sizeListeners.delete(listener);
  }

  onExit(listener: VideoPipelineEvents["onExit"]): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Controller of the VIDEO instance. Position-dependent input (touch,
   * scroll) MUST go through here: scrcpy maps coordinates against the
   * instance's own capture size, and only this instance's size matches the
   * frames viewers actually see. The persistent control instance runs
   * `video: false`, so its ScreenInfo is the native display size — sending
   * scaled-video coordinates there lands them in the wrong place.
   */
  get controller() {
    return this.client.controller;
  }

  /** Ask the encoder for a fresh configuration + keyframe (scrcpy >= 3.0). */
  async resetVideo(): Promise<void> {
    await this.client.controller?.resetVideo();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }

  private async consumeVideo(stream: ReadableStream<ScrcpyMediaStreamPacket>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === "configuration") this.currentConfig = value.data;
        for (const listener of this.packetListeners) listener(value);
      }
    } catch {
      // Stream broke — exit handling below tears the pipeline down.
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeOutput(): Promise<void> {
    const reader = this.client.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.trim()) console.log(`[scrcpy:video] ${value.trim()}`);
      }
    } catch {
      // Closed with the session.
    }
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.exitListeners) listener();
  }
}
