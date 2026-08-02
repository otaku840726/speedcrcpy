import {
  DEFAULT_LADDER_INDEX,
  nearestLadderIndex,
  QUALITY_LADDER,
  sameQuality,
  type QualitySettings,
  type SessionConnections,
  type VideoCodec,
  type ViewerConnection,
} from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import type { ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import type { AdbManager } from "../adb/adb-manager.js";
import { SessionCongestion } from "../transport/congestion.js";
import { DeviceSession } from "./device-session.js";
import type { DisplayManager } from "./display-override.js";
import { VideoPipeline } from "./video-pipeline.js";

const RESET_VIDEO_DEBOUNCE_MS = 1_000;
/** A day, in the milliseconds Android's setting uses. Long enough that no
 * viewing session reaches it, and restored by scrcpy on close either way. */
const SESSION_SCREEN_OFF_TIMEOUT_MS = 86_400_000;
const SWITCH_TIMEOUT_MS = 8_000;

export interface SessionViewer {
  readonly id: string;
  connectionInfo(controlling: boolean): ViewerConnection;
  /** Admin eviction — stop the client reconnecting and drop it. */
  kick(): void;
  notifyDeviceGone(): void;
  /**
   * Video stream restarted (quality switch): resend META/config, flush queue.
   * `byAuto` marks a change the congestion controller made on its own.
   */
  notifyVideoRestarted(byAuto: boolean): void;
  /** Auto/manual mode (or pinned quality) changed without restarting the stream. */
  notifyQualityMode(): void;
  notifyControlChanged(controlling: boolean): void;
  notifyScreenOffChanged(off: boolean): void;
}

/** A running per-device pair of scrcpy instances plus attached viewers. */
export class ManagedSession {
  readonly viewers = new Set<SessionViewer>();
  /** When true the congestion controller drives quality along the ladder. */
  autoAdapt = true;
  /** Encoder settings the video pipeline is currently running at. */
  quality: QualitySettings;
  /** Codec the video pipeline is currently encoding ("h264" | "h265"). */
  videoCodec: VideoCodec;
  /** Auto mode's current ladder rung (ignored while autoAdapt is false). */
  autoLadderIdx: number;
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
    /**
     * Grace period (ms) to keep the session warm after the last viewer leaves.
     * <= 0 keeps it warm indefinitely (torn down only when the device drops).
     */
    private readonly lingerMs: number,
    /** Persist the user's quality/codec choice so it survives a session teardown. */
    private readonly onQualityPersist: (auto: boolean, quality: QualitySettings, codec: VideoCodec) => void,
  ) {
    this.quality = video.config.quality;
    this.videoCodec = video.config.codec;
    this.autoLadderIdx = nearestLadderIndex(video.config.quality);
    this.wireVideo(video);
    this.congestion = new SessionCongestion(this);
  }

  private controllingViewer: SessionViewer | undefined;
  /** Per-viewer auto-mode ladder ceiling (highest index they can decode). */
  private readonly viewerCaps = new Map<SessionViewer, number>();

  /** Highest ladder index (= lowest quality) any viewer cap forces. */
  effectiveCeilingIdx(): number {
    let idx = 0;
    for (const cap of this.viewerCaps.values()) idx = Math.max(idx, cap);
    return idx;
  }

  /**
   * Worst-viewer-wins: a capped viewer (e.g. a software decoder) immediately
   * lowers a higher auto stream. Only enforced in auto mode — a manual pin is
   * the user's explicit choice.
   */
  setViewerCap(viewer: SessionViewer, maxLadderIndex: number): void {
    if (maxLadderIndex < 0 || maxLadderIndex >= QUALITY_LADDER.length) return;
    this.viewerCaps.set(viewer, maxLadderIndex);
    if (this.autoAdapt && this.autoLadderIdx < maxLadderIndex) {
      void this.autoStepTo(maxLadderIndex);
    }
  }

  attach(viewer: SessionViewer): void {
    this.viewers.add(viewer);
    // Alone on the device: you opened it to use it, and a reconnect after a
    // dropped socket should put you back where you were. With anyone else
    // already attached, join view-only even when nobody is driving — control is
    // asked for, never handed out.
    if (this.viewers.size === 1) this.controllingViewer ??= viewer;
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = undefined;
    }
  }

  detach(viewer: SessionViewer): void {
    this.viewers.delete(viewer);
    this.viewerCaps.delete(viewer);
    if (this.controllingViewer === viewer) {
      // Nobody inherits it. Someone who opened a session to watch did not ask
      // to drive a real phone, and promoting them the moment the driver leaves
      // turns their next stray tap into a real one. The device stays
      // uncontrolled until a viewer presses 取得控制.
      this.controllingViewer = undefined;
    }
    // lingerMs <= 0: keep the session warm indefinitely (instant reattach, at
    // the cost of the device encoding continuously with no viewer).
    if (this.viewers.size === 0 && !this.lingerTimer && this.lingerMs > 0) {
      this.lingerTimer = setTimeout(() => this.onEmptyClose(), this.lingerMs);
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

  /** Snapshot of attached viewers for the connection admin listing. */
  connections(): ViewerConnection[] {
    return [...this.viewers].map((v) => v.connectionInfo(this.controllingViewer === v));
  }

  /** Evict one viewer by id (returns true if found). detach() runs on close. */
  kick(viewerId: string): boolean {
    for (const viewer of this.viewers) {
      if (viewer.id === viewerId) {
        viewer.kick();
        return true;
      }
    }
    return false;
  }

  /** Evict every viewer of this device; returns how many. */
  kickAll(): number {
    const all = [...this.viewers];
    for (const viewer of all) viewer.kick();
    return all.length;
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
   * Apply a user quality choice. `auto` true resumes ladder adaptation
   * (starting from the rung nearest `quality`, clamped to the viewer ceiling);
   * false pins `quality` exactly and silences the congestion controller. The
   * choice is persisted so a later session for this device restores it.
   */
  async setQualityMode(auto: boolean, quality: QualitySettings): Promise<void> {
    const modeFlipped = this.autoAdapt !== auto;
    this.autoAdapt = auto;

    let target: QualitySettings;
    if (auto) {
      const idx = Math.max(nearestLadderIndex(quality), this.effectiveCeilingIdx());
      this.autoLadderIdx = idx;
      target = QUALITY_LADDER[idx]!;
    } else {
      target = quality;
    }
    this.onQualityPersist(auto, target, this.videoCodec);

    if (sameQuality(target, this.quality)) {
      // Encoder unchanged — just broadcast the flipped mode so viewers' toggles
      // stay in sync (no stream restart / video blip).
      if (modeFlipped) for (const viewer of this.viewers) viewer.notifyQualityMode();
      return;
    }
    await this.switchQuality(target, false);
  }

  /** Switch the device encoder codec live (persisted; make-before-break restart). */
  async setCodec(codec: VideoCodec): Promise<void> {
    if (codec === this.videoCodec) return;
    this.onQualityPersist(this.autoAdapt, this.quality, codec);
    await this.switchQuality(this.quality, false, codec);
  }

  /** Step auto mode to a ladder rung (congestion controller / viewer cap). */
  async autoStepTo(idx: number): Promise<void> {
    this.autoLadderIdx = idx;
    await this.switchQuality(QUALITY_LADDER[idx]!, true);
  }

  /**
   * Make-before-break quality switch: start a second scrcpy video instance
   * (new scid), wait for its config + first keyframe, atomically swap the
   * fan-out source, then kill the old instance. Input, audio and clipboard
   * live in the persistent DeviceSession and are never touched.
   */
  async switchQuality(quality: QualitySettings, byAuto: boolean, codec: VideoCodec = this.videoCodec): Promise<boolean> {
    if (this.switching || (sameQuality(quality, this.quality) && codec === this.videoCodec)) return false;
    this.switching = true;

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

    let next: VideoPipeline | undefined;
    try {
      // The new scrcpy instance can die on startup (device busy, second
      // encoder rejected, stream ends before metadata) — that must NOT crash
      // the process or disturb the still-running current pipeline.
      next = await VideoPipeline.start(
        this.adb,
        { quality, codec, intraRefresh: this.video.config.intraRefresh },
        this.serial,
        initialListener,
      );

      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SWITCH_TIMEOUT_MS));
      await Promise.race([ready, timeout]);

      if (!sawKeyframe) {
        await next.close().catch(() => {});
        return false;
      }

      const old = this.video;
      this.video = next;
      this.quality = quality;
      this.videoCodec = codec;

      // Swap: stop forwarding the old stream, tell viewers to restart their
      // decoders, replay the buffered config+keyframe, then go live.
      for (const unsub of this.videoUnsubs) unsub();
      for (const viewer of this.viewers) viewer.notifyVideoRestarted(byAuto);
      for (const packet of buffered) {
        for (const listener of this.packetListeners) listener(packet);
      }
      next.removePacketListener(initialListener);
      this.wireVideo(next);

      void old.close().catch(() => {});
      return true;
    } catch (error) {
      // Keep the current pipeline running at the current preset.
      console.warn(
        `[session] quality switch to ${quality.maxSize}px/${quality.videoBitRate} failed for ${this.serial}: ${(error as Error).message}`,
      );
      if (next) await next.close().catch(() => {});
      return false;
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
  /** Last quality/codec choice per device, so a new session restores it. */
  private readonly deviceQuality = new Map<
    string,
    { auto: boolean; quality: QualitySettings; codec: VideoCodec }
  >();

  constructor(
    private readonly adbManager: AdbManager,
    private readonly screenOffDefault = false,
    /** Warm-linger after the last viewer leaves (ms); <= 0 = keep warm forever. */
    private readonly sessionLingerMs = 60_000,
    /** Default codec new sessions encode with ("h264" | "h265"). */
    private readonly videoCodec: VideoCodec = "h264",
    /** Notified when a device is taken by / released from a viewer session. */
    private readonly onSessionActive?: (serial: string, active: boolean) => void,
    /** Re-applies any persisted display-resolution override before capture starts. */
    private readonly displayManager?: DisplayManager,
  ) {}

  /** Start (or join) the session for a device. Callers must attach a viewer. */
  acquire(serial: string): Promise<ManagedSession> {
    let pending = this.sessions.get(serial);
    if (!pending) {
      // Release the idle screen-off keeper before starting our own control
      // instance, so the two don't fight over the panel.
      this.onSessionActive?.(serial, true);
      pending = this.create(serial);
      this.sessions.set(serial, pending);
      pending.catch(() => {
        this.sessions.delete(serial);
        this.onSessionActive?.(serial, false);
      });
    }
    return pending;
  }

  /** Active viewer connections across all running sessions (empty ones omitted). */
  async listConnections(): Promise<SessionConnections[]> {
    const settled = await Promise.allSettled(this.sessions.values());
    const out: SessionConnections[] = [];
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      const session = r.value;
      const viewers = session.connections();
      if (viewers.length > 0) out.push({ serial: session.serial, deviceName: session.deviceName, viewers });
    }
    return out;
  }

  /** Evict a viewer by id from whichever session holds it. */
  async kick(viewerId: string): Promise<boolean> {
    const settled = await Promise.allSettled(this.sessions.values());
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value.kick(viewerId)) return true;
    }
    return false;
  }

  /** Evict every viewer of one device; returns how many were kicked. */
  async kickDevice(serial: string): Promise<number> {
    const pending = this.sessions.get(serial);
    if (!pending) return 0;
    try {
      return (await pending).kickAll();
    } catch {
      return 0;
    }
  }

  /** Nudge an active session to re-read the display after a resolution change. */
  async pokeVideo(serial: string): Promise<void> {
    const pending = this.sessions.get(serial);
    if (!pending) return;
    try {
      await (await pending).requestResetVideo();
    } catch {
      /* session tearing down */
    }
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(pending.map(async (p) => (await p).close()));
  }

  private async create(serial: string): Promise<ManagedSession> {
    const info = this.adbManager.deviceInfos().find((d) => d.serial === serial);
    const adb = await this.adbManager.createAdb(serial);

    // When screen-off is the standing policy, keep it off after the session
    // ends / the server dies too (scrcpy powers off on close).
    const device = await DeviceSession.start(adb, {
      powerOffOnClose: this.screenOffDefault,
      // Hold the device's screen-off timeout for as long as someone is
      // mirroring. Without it, powering the panel off leaves Android's own
      // inactivity timer running, the device dozes, and a dozing device
      // composes nothing — the picture goes black seconds after connecting.
      // scrcpy restores the original value when this instance closes.
      screenOffTimeoutMs: SESSION_SCREEN_OFF_TIMEOUT_MS,
      wakeOnStart: true,
    });

    // Restore the device's last quality choice; auto mode starts from the rung
    // nearest the stored settings (it re-adapts anyway), manual pins it exactly.
    const stored = this.deviceQuality.get(serial);
    const startAuto = stored?.auto ?? true;
    const quality = stored
      ? stored.auto
        ? QUALITY_LADDER[nearestLadderIndex(stored.quality)]!
        : stored.quality
      : QUALITY_LADDER[DEFAULT_LADDER_INDEX]!;
    const codec = stored?.codec ?? this.videoCodec;

    // Re-apply any persisted resolution override before capture starts (a device
    // reboot clears wm overrides), so scrcpy captures at the chosen size.
    await this.displayManager?.reapplyStored(serial).catch((error: unknown) => {
      console.warn(`[display] reapply failed for ${serial}: ${error instanceof Error ? error.message : error}`);
    });

    const video = await VideoPipeline.start(adb, { quality, codec, intraRefresh: true }, serial);

    const onGone = () => void this.teardown(serial, "exited");
    const session = new ManagedSession(
      serial,
      info?.name ?? serial,
      adb,
      device,
      video,
      () => void this.teardown(serial, "idle"),
      onGone,
      this.sessionLingerMs,
      (auto, q, c) => this.deviceQuality.set(serial, { auto, quality: q, codec: c }),
    );
    session.autoAdapt = startAuto;
    device.onExit(onGone);

    if (this.screenOffDefault) device.setScreenOff(true);

    console.log(`[session] started for ${serial} (${video.codec} ${video.width}x${video.height})`);
    return session;
  }

  private async teardown(serial: string, reason: string): Promise<void> {
    const pending = this.sessions.get(serial);
    if (!pending) return;
    this.onSessionActive?.(serial, false);
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
