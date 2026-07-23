import { DEFAULT_PRESET_ID, presetById, presetIndex, QUALITY_LADDER, type QualityPreset } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { AdbManager } from "../adb/adb-manager.js";
import { SessionCongestion } from "../transport/congestion.js";
import { DeviceSession } from "./device-session.js";
import { VideoPipeline } from "./video-pipeline.js";

// Keep the device session warm after the last viewer drops — mobile browsers
// kill background-tab sockets within seconds, and reattaching to a live
// session is instant while a cold start takes ~2 s.
const LINGER_MS = 60_000;
const RESET_VIDEO_DEBOUNCE_MS = 1_000;
const SWITCH_TIMEOUT_MS = 8_000;

export interface SessionViewer {
  notifyDeviceGone(): void;
  /** Video stream restarted (quality switch): resend META/config, flush queue. */
  notifyVideoRestarted(auto: boolean): void;
  notifyControlChanged(controlling: boolean): void;
  notifyScreenOffChanged(off: boolean): void;
}

/** A running per-device pair of scrcpy instances plus attached viewers. */
export class ManagedSession {
  readonly viewers = new Set<SessionViewer>();
  presetId: string;
  /** Set when the user picked a preset manually — auto-adaptation won't step up past it. */
  manualPresetId: string | undefined;
  readonly congestion: SessionCongestion;

  private readonly packetListeners = new Set<(packet: ScrcpyMediaStreamPacket) => void>();
  private readonly sizeListeners = new Set<(size: { width: number; height: number }) => void>();
  private videoUnsubs: (() => void)[] = [];
  private lastResetAt = 0;
  private lingerTimer: NodeJS.Timeout | undefined;
  private switching = false;

  constructor(
    readonly serial: string,
    readonly deviceName: string,
    readonly adb: Adb,
    readonly device: DeviceSession,
    public video: VideoPipeline,
    private readonly onEmptyClose: () => void,
    private readonly onVideoExit: () => void,
  ) {
    this.presetId = video.config.preset.id;
    this.wireVideo(video);
    this.congestion = new SessionCongestion(this);
  }

  private controllingViewer: SessionViewer | undefined;
  /** Per-viewer quality ceiling (ladder index), e.g. software decoders. */
  private readonly viewerCaps = new Map<SessionViewer, number>();

  /** Highest ladder index (= lowest quality) among pin and viewer caps. */
  effectiveCeilingIdx(): number {
    let idx = this.manualPresetId ? presetIndex(this.manualPresetId) : 0;
    for (const cap of this.viewerCaps.values()) idx = Math.max(idx, cap);
    return idx;
  }

  /** Worst-viewer-wins: a capped viewer immediately lowers a higher stream. */
  setViewerCap(viewer: SessionViewer, presetId: string): void {
    const capIdx = presetIndex(presetId);
    if (capIdx < 0) return;
    this.viewerCaps.set(viewer, capIdx);
    if (presetIndex(this.presetId) < capIdx) {
      void this.switchQuality(QUALITY_LADDER[capIdx]!, true);
    }
  }

  attach(viewer: SessionViewer): void {
    this.viewers.add(viewer);
    // First viewer controls; later viewers join view-only.
    this.controllingViewer ??= viewer;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
  }

  detach(viewer: SessionViewer): void {
    this.viewers.delete(viewer);
    this.viewerCaps.delete(viewer);
    if (this.controllingViewer === viewer) {
      // Hand control to the longest-connected remaining viewer.
      this.controllingViewer = this.viewers.values().next().value;
      this.controllingViewer?.notifyControlChanged(true);
    }
    if (this.viewers.size === 0 && !this.lingerTimer) {
      this.lingerTimer = setTimeout(() => this.onEmptyClose(), LINGER_MS);
    }
  }

  isControlling(viewer: SessionViewer): boolean {
    return this.controllingViewer === viewer;
  }

  takeControl(viewer: SessionViewer): void {
    if (this.controllingViewer === viewer) return;
    const previous = this.controllingViewer;
    this.controllingViewer = viewer;
    previous?.notifyControlChanged(false);
    viewer.notifyControlChanged(true);
  }

  get screenOff(): boolean {
    return this.device.screenOff;
  }

  /** Device-level state — shared across all viewers of this device. */
  setScreenOff(off: boolean): void {
    if (this.device.screenOff === off) return;
    this.device.setScreenOff(off);
    for (const viewer of this.viewers) viewer.notifyScreenOffChanged(off);
  }

  onVideoPacket(listener: (packet: ScrcpyMediaStreamPacket) => void): () => void {
    this.packetListeners.add(listener);
    return () => this.packetListeners.delete(listener);
  }

  onVideoSizeChanged(listener: (size: { width: number; height: number }) => void): () => void {
    this.sizeListeners.add(listener);
    return () => this.sizeListeners.delete(listener);
  }

  /** Debounced: a reset re-keys every viewer of this device. */
  async requestResetVideo(): Promise<void> {
    const now = Date.now();
    if (now - this.lastResetAt < RESET_VIDEO_DEBOUNCE_MS) return;
    this.lastResetAt = now;
    await this.video.resetVideo().catch(() => {});
  }

  /**
   * Make-before-break quality switch: start a second scrcpy video instance
   * (new scid), wait for its config + first keyframe, atomically swap the
   * fan-out source, then kill the old instance. Input, audio and clipboard
   * live in the persistent DeviceSession and are never touched.
   */
  async switchQuality(preset: QualityPreset, auto: boolean): Promise<boolean> {
    if (this.switching || preset.id === this.presetId) return false;
    this.switching = true;

    try {
      // Buffer everything the new encoder emits until we're ready to swap, so
      // the first keyframe is never lost.
      const buffered: ScrcpyMediaStreamPacket[] = [];
      let sawKeyframe = false;
      let resolveReady!: () => void;
      const ready = new Promise<void>((resolve) => (resolveReady = resolve));

      const initialListener = (packet: ScrcpyMediaStreamPacket) => {
        buffered.push(packet);
        if (packet.type === "data" && packet.keyframe) {
          sawKeyframe = true;
          resolveReady();
        }
      };

      const next = await VideoPipeline.start(
        this.adb,
        { preset, codec: this.video.config.codec, intraRefresh: this.video.config.intraRefresh },
        initialListener,
      );

      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SWITCH_TIMEOUT_MS));
      await Promise.race([ready, timeout]);

      if (!sawKeyframe) {
        await next.close();
        return false;
      }

      const old = this.video;
      this.video = next;
      this.presetId = preset.id;

      // Swap: stop forwarding the old stream, tell viewers to restart their
      // decoders, replay the buffered config+keyframe, then go live.
      for (const unsub of this.videoUnsubs) unsub();
      for (const viewer of this.viewers) viewer.notifyVideoRestarted(auto);
      for (const packet of buffered) {
        for (const listener of this.packetListeners) listener(packet);
      }
      next.removePacketListener(initialListener);
      this.wireVideo(next);

      void old.close();
      return true;
    } finally {
      this.switching = false;
    }
  }

  async close(): Promise<void> {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.congestion.dispose();
    for (const viewer of this.viewers) viewer.notifyDeviceGone();
    this.viewers.clear();
    await Promise.allSettled([this.video.close(), this.device.close()]);
  }

  private wireVideo(pipeline: VideoPipeline): void {
    this.videoUnsubs = [
      pipeline.onPacket((packet) => {
        for (const listener of this.packetListeners) listener(packet);
      }),
      pipeline.onSizeChanged((size) => {
        for (const listener of this.sizeListeners) listener(size);
      }),
      pipeline.onExit(() => this.onVideoExit()),
    ];
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Promise<ManagedSession>>();

  constructor(
    private readonly adbManager: AdbManager,
    private readonly screenOffDefault = false,
  ) {}

  /** Start (or join) the session for a device. Callers must attach a viewer. */
  acquire(serial: string): Promise<ManagedSession> {
    let pending = this.sessions.get(serial);
    if (!pending) {
      pending = this.create(serial);
      this.sessions.set(serial, pending);
      pending.catch(() => this.sessions.delete(serial));
    }
    return pending;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (p) => (await p).close()));
  }

  private async create(serial: string): Promise<ManagedSession> {
    const info = this.adbManager.deviceInfos().find((d) => d.serial === serial);
    const adb = await this.adbManager.createAdb(serial);

    const device = await DeviceSession.start(adb);
    const preset: QualityPreset = presetById(DEFAULT_PRESET_ID)!;
    const video = await VideoPipeline.start(adb, { preset, codec: "h264", intraRefresh: true });

    const onGone = () => void this.teardown(serial, "exited");
    const session = new ManagedSession(
      serial,
      info?.name ?? serial,
      adb,
      device,
      video,
      () => void this.teardown(serial, "idle"),
      onGone,
    );
    device.onExit(onGone);

    if (this.screenOffDefault) device.setScreenOff(true);

    console.log(`[session] started for ${serial} (${video.codec} ${video.width}x${video.height})`);
    return session;
  }

  private async teardown(serial: string, reason: string): Promise<void> {
    const pending = this.sessions.get(serial);
    if (!pending) return;
    this.sessions.delete(serial);
    try {
      const session = await pending;
      console.log(`[session] closing ${serial} (${reason})`);
      await session.close();
    } catch {
      // Session never started; nothing to close.
    }
  }
}
