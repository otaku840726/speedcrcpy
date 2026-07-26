import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, type AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { ScrcpyVideoCodecId, type ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { ReadableStreamDefaultReader } from "@yume-chan/stream-extra";
import { makeVideoOptions, type VideoSessionConfig } from "./options.js";
import { pushServer, removeServer } from "./server-binary.js";

/** Devices whose encoder rejected a forced Baseline profile (start()). */
const baselineUnsupported = new Set<string>();

/** Max wait for the first video metadata before treating the start as failed. */
const START_TIMEOUT_MS = 5_000;
/** Max wait for the first actual frame (an encoder that rejected the options
 * sends metadata then produces nothing). */
const FRAME_TIMEOUT_MS = 4_000;

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
   *
   * `serial` scopes the forced-Baseline fallback cache: some encoders reject a
   * forced profile and fail to configure, so we retry without it once and
   * remember that for the device.
   */
  static async start(
    adb: Adb,
    config: VideoSessionConfig,
    serial: string,
    initialListener?: VideoPipelineEvents["onPacket"],
  ): Promise<VideoPipeline> {
    // Forced Baseline is an H.264 concept (for the TinyH264 software decoder);
    // it doesn't apply to H.265, so never force it there.
    const forceBaseline = config.codec === "h264" && !baselineUnsupported.has(serial);
    let started;
    try {
      started = await VideoPipeline.startClient(adb, config, forceBaseline);
    } catch (error) {
      if (forceBaseline) {
        // The encoder likely rejected the forced Baseline profile — remember
        // it for this device and retry with the encoder's native profile.
        console.warn(`[scrcpy:video] ${serial} rejected forced Baseline, using native profile`);
        baselineUnsupported.add(serial);
        started = await VideoPipeline.startClient(adb, config, false);
      } else {
        throw error;
      }
    }

    const { client, video, reader, buffered } = started;
    const pipeline = new VideoPipeline(client, config, video.metadata.codec, video.width, video.height);
    if (initialListener) pipeline.packetListeners.add(initialListener);

    video.sizeChanged((size) => {
      pipeline.width = size.width;
      pipeline.height = size.height;
      for (const listener of pipeline.sizeListeners) listener(size);
    });

    void pipeline.consumeVideo(reader, buffered);
    void pipeline.consumeOutput();
    void client.exited.catch(() => {}).then(() => pipeline.handleExit());

    return pipeline;
  }

  /**
   * Push the server, start a video instance, and confirm it actually produces
   * frames. An encoder that rejects the codec options still sends metadata
   * (videoStream resolves), then fails during encode and emits no frames — so
   * we read until the first data packet before declaring success, buffering
   * what we read for the pipeline to replay. Metadata timeout, process exit, or
   * no-frames all reject so the caller can fall back to the native profile.
   */
  private static async startClient(adb: Adb, config: VideoSessionConfig, forceBaseline: boolean) {
    // Unique jar per instance — see pushServer for the unlink race this avoids.
    const serverPath = await pushServer(adb);
    let client: AdbScrcpyClient<AdbScrcpyOptionsLatest<true>> | undefined;
    try {
      client = await AdbScrcpyClient.start(adb, serverPath, makeVideoOptions(config, forceBaseline));
      const c = client;

      let metaTimer: NodeJS.Timeout | undefined;
      const video = await Promise.race([
        c.videoStream,
        c.exited.then(() => Promise.reject(new Error("scrcpy exited before video stream"))),
        new Promise<never>((_, reject) => {
          metaTimer = setTimeout(() => reject(new Error("video metadata timeout")), START_TIMEOUT_MS);
        }),
      ]);
      if (metaTimer) clearTimeout(metaTimer);

      const reader = video.stream.getReader();
      const buffered: ScrcpyMediaStreamPacket[] = [];
      await new Promise<void>((resolve, reject) => {
        const frameTimer = setTimeout(() => reject(new Error("no video frames")), FRAME_TIMEOUT_MS);
        void c.exited.then(() => reject(new Error("scrcpy exited before frames"))).catch(() => {});
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                reject(new Error("video stream ended before frames"));
                return;
              }
              buffered.push(value);
              if (value.type === "data") {
                clearTimeout(frameTimer);
                resolve();
                return;
              }
            }
          } catch (error) {
            reject(error as Error);
          }
        })();
      });

      return { client, video, reader, buffered };
    } catch (error) {
      void removeServer(adb, serverPath);
      await client?.close().catch(() => {});
      throw error;
    }
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

  /**
   * @param reader already locked by startClient (which read the first frames).
   * @param buffered packets startClient consumed while confirming frames; they
   *   are replayed to listeners before resuming the live read.
   */
  private async consumeVideo(
    reader: ReadableStreamDefaultReader<ScrcpyMediaStreamPacket>,
    buffered: ScrcpyMediaStreamPacket[],
  ): Promise<void> {
    try {
      for (const value of buffered) {
        if (value.type === "configuration") this.currentConfig = value.data;
        for (const listener of this.packetListeners) listener(value);
      }
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
