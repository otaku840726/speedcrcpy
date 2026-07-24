import { QUALITY_LADDER } from "@speedcrcpy/shared";
import type { ManagedSession } from "../scrcpy/session-manager.js";
import type { SendQueue } from "./send-queue.js";

const SAMPLE_MS = 100;
const PING_MS = 1_000;

const BACKPRESSURE_BYTES = 256 * 1024;
const STALL_BYTES = 1024 * 1024;
const DRAINED_BYTES = 64 * 1024;
const DELAY_GRADIENT_BACKPRESSURE_MS = 300;
const STALL_NO_DRAIN_MS = 2_000;

const STEP_DOWN_FAST_TRIGGERS = 3;
const FAST_TRIGGER_WINDOW_MS = 10_000;
const THROUGHPUT_LOW_RATIO = 0.8;
const THROUGHPUT_LOW_SUSTAIN_MS = 3_000;
const STEP_UP_HEALTHY_MS = 20_000;

export type CongestionLevel = "ok" | "backpressure" | "stalled";
export type VideoMode = "through" | "gate";

export interface ViewerCongestionHooks {
  sendPing(pingId: number, sentAt: number): void;
  /** Gate on/off — while gated the viewer stops enqueueing video data. */
  setGate(gated: boolean): void;
  /** Gate released after drain: ask for a fresh keyframe. */
  requestKeyframe(): void;
  emitStats(stats: {
    sendBitrate: number;
    rttMs: number;
    delayGradientMs: number;
    congestion: CongestionLevel;
    mode: VideoMode;
  }): void;
}

/**
 * Per-viewer congestion detector — two signals:
 * 1. Local socket backpressure (ws bufferedAmount), which sees the server's
 *    own kernel queue only.
 * 2. Client receive-delay gradient from ping/pong timestamps: the trend of
 *    (clientReceivedAt - serverSentAt) exposes bufferbloat anywhere along the
 *    path — invisible to bufferedAmount — without needing synchronized clocks.
 *
 * Fast tier: "through" mode lets the send queue drop frames and keeps feeding
 * (decode-through mosaic, healed by intra-refresh); "gate" mode stops video
 * until drained, then requests a keyframe. Mode starts as "through" and
 * falls back to "gate" permanently if the client's decoder rejects gaps.
 */
export class ViewerCongestion {
  mode: VideoMode = "through";
  level: CongestionLevel = "ok";

  private sampleTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private nextPingId = 1;
  private readonly pingSentAt = new Map<number, number>();
  private rttMs = 0;

  /** Sliding-window minimum (60 s) — an all-time min gets poisoned by clock
   * drift/NTP steps and then reports a permanently inflated gradient. */
  private readonly delaySamples: { t: number; d: number }[] = [];
  private delayGradientMs = 0;

  private lastSentBytes = 0;
  private sendBitrate = 0;
  private backpressureSince: number | undefined;
  private lastDrainAt = Date.now();
  private gated = false;

  private readonly fastTriggers: number[] = [];

  constructor(
    private readonly queue: SendQueue,
    private readonly hooks: ViewerCongestionHooks,
  ) {
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_MS);
    this.pingTimer = setInterval(() => this.ping(), PING_MS);
  }

  handlePong(pingId: number, serverSentAt: number, clientReceivedAt: number): void {
    const now = Date.now();
    const sentAt = this.pingSentAt.get(pingId);
    if (sentAt !== undefined) {
      this.pingSentAt.delete(pingId);
      this.rttMs = now - sentAt;
    }
    // Background tabs answer pings seconds late — those say nothing about
    // the network; discard instead of polluting the gradient.
    if (sentAt !== undefined && now - sentAt > 5_000) return;

    // Clock offset is constant on short horizons; only the trend matters.
    const relativeDelay = clientReceivedAt - serverSentAt;
    this.delaySamples.push({ t: now, d: relativeDelay });
    const cutoff = now - 60_000;
    while (this.delaySamples.length > 0 && this.delaySamples[0]!.t < cutoff) this.delaySamples.shift();
    let base = Number.POSITIVE_INFINITY;
    for (const sample of this.delaySamples) base = Math.min(base, sample.d);
    this.delayGradientMs = relativeDelay - base;
  }

  onDecoderError(): void {
    // This client's decoder can't ride through missing references.
    this.mode = "gate";
  }

  /** Fast-tier trigger timestamps within the sliding window. */
  recentFastTriggers(): number {
    const cutoff = Date.now() - FAST_TRIGGER_WINDOW_MS;
    while (this.fastTriggers.length > 0 && this.fastTriggers[0]! < cutoff) this.fastTriggers.shift();
    return this.fastTriggers.length;
  }

  get currentSendBitrate(): number {
    return this.sendBitrate;
  }

  /** True only when data is actually piling up in the socket — the
   * precondition for any throughput-based conclusion. */
  get isBacklogged(): boolean {
    return this.queue.bufferedBytes > BACKPRESSURE_BYTES || this.level === "stalled";
  }

  get isHealthy(): boolean {
    return this.level === "ok" && this.delayGradientMs < DELAY_GRADIENT_BACKPRESSURE_MS / 2;
  }

  dispose(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.sampleTimer = undefined;
    this.pingTimer = undefined;
  }

  private ping(): void {
    const pingId = this.nextPingId++;
    const sentAt = Date.now();
    this.pingSentAt.set(pingId, sentAt);
    if (this.pingSentAt.size > 10) {
      const oldest = this.pingSentAt.keys().next().value;
      if (oldest !== undefined) this.pingSentAt.delete(oldest);
    }
    this.hooks.sendPing(pingId, sentAt);
    this.hooks.emitStats({
      sendBitrate: this.sendBitrate,
      rttMs: this.rttMs,
      delayGradientMs: this.delayGradientMs,
      congestion: this.level,
      mode: this.mode,
    });
  }

  private sample(): void {
    const now = Date.now();
    const buffered = this.queue.bufferedBytes;

    // Send-rate EWMA from per-send accounting (finer than bufferedAmount).
    const sent = this.queue.sentBytes;
    const instantRate = ((sent - this.lastSentBytes) * 8 * 1000) / SAMPLE_MS;
    this.lastSentBytes = sent;
    this.sendBitrate = this.sendBitrate * 0.9 + instantRate * 0.1;

    if (buffered < DRAINED_BYTES) this.lastDrainAt = now;

    // Level classification from both signals.
    const overBackpressure =
      buffered > BACKPRESSURE_BYTES || this.delayGradientMs > DELAY_GRADIENT_BACKPRESSURE_MS;
    if (overBackpressure) {
      this.backpressureSince ??= now;
    } else {
      this.backpressureSince = undefined;
    }

    let level: CongestionLevel = "ok";
    if (buffered > STALL_BYTES || now - this.lastDrainAt > STALL_NO_DRAIN_MS) {
      level = "stalled";
    } else if (this.backpressureSince !== undefined && now - this.backpressureSince > 500) {
      level = "backpressure";
    }

    if (level !== "ok" && this.level === "ok") {
      this.fastTriggers.push(now);
    }
    this.level = level;

    // Fast tier.
    if (this.mode === "gate") {
      if (!this.gated && level !== "ok") {
        this.gated = true;
        this.queue.clearVideo();
        this.hooks.setGate(true);
      } else if (this.gated && buffered < DRAINED_BYTES) {
        this.gated = false;
        this.hooks.setGate(false);
        this.hooks.requestKeyframe();
      }
    } else if (level === "stalled") {
      // Even in decode-through, a stalled socket means queued frames are pure
      // latency — drop them all and resync once drained.
      this.queue.clearVideo();
      this.hooks.requestKeyframe();
    }
  }
}

/**
 * Session-level slow tier: steps the quality ladder from the aggregated state
 * of all viewers (worst-viewer-wins downward, unanimous health upward).
 */
export class SessionCongestion {
  private readonly viewers = new Set<ViewerCongestion>();
  private timer: NodeJS.Timeout | undefined;
  private healthySince = Date.now();
  private lowThroughputSince: number | undefined;
  private lastStepAt = 0;

  constructor(private readonly session: ManagedSession) {
    this.timer = setInterval(() => this.tick(), 1_000);
  }

  register(viewer: ViewerCongestion): () => void {
    this.viewers.add(viewer);
    return () => this.viewers.delete(viewer);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.viewers.size === 0) return;
    // Manual mode pins the encoder; the ladder controller stays out of the way.
    if (!this.session.autoAdapt) return;
    const now = Date.now();
    const currentIdx = this.session.autoLadderIdx;
    const rung = QUALITY_LADDER[currentIdx]!;

    let worstTriggers = 0;
    let allHealthy = true;
    let backloggedAndSlow = false;
    for (const viewer of this.viewers) {
      worstTriggers = Math.max(worstTriggers, viewer.recentFastTriggers());
      if (!viewer.isHealthy) allHealthy = false;
      // "Throughput too low" is only meaningful when data is actually queued:
      // with CBR + a static screen the encoder sends a fraction of the nominal
      // bitrate, so comparing send rate against the preset without a backlog
      // check is trivially true and slides the ladder to the bottom.
      if (viewer.isBacklogged && viewer.currentSendBitrate < rung.videoBitRate * THROUGHPUT_LOW_RATIO) {
        backloggedAndSlow = true;
      }
    }

    const throughputLow = backloggedAndSlow;
    if (throughputLow) {
      this.lowThroughputSince ??= now;
    } else {
      this.lowThroughputSince = undefined;
    }

    if (!allHealthy) this.healthySince = now;

    // Hysteresis: at most one ladder step per 5 s down / 20 s up.
    const stepDown =
      worstTriggers >= STEP_DOWN_FAST_TRIGGERS ||
      (this.lowThroughputSince !== undefined && now - this.lowThroughputSince > THROUGHPUT_LOW_SUSTAIN_MS);

    if (stepDown && currentIdx < QUALITY_LADDER.length - 1 && now - this.lastStepAt > 5_000) {
      this.lastStepAt = now;
      this.lowThroughputSince = undefined;
      void this.session.autoStepTo(currentIdx + 1);
      return;
    }

    // Step up only toward the effective ceiling: every viewer's advertised
    // capability (software decoders cap themselves at a lower rung).
    const ceilingIdx = this.session.effectiveCeilingIdx();
    if (
      allHealthy &&
      now - this.healthySince > STEP_UP_HEALTHY_MS &&
      currentIdx > ceilingIdx &&
      now - this.lastStepAt > STEP_UP_HEALTHY_MS
    ) {
      this.lastStepAt = now;
      void this.session.autoStepTo(currentIdx - 1);
    }
  }
}
