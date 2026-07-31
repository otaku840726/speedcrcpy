import type { AdbManager } from "../adb/adb-manager.js";
import { capture as screencap, type Frame } from "../scripts/vision.js";
import { thumbnailFromFrame } from "./screenshot.js";

/** Never re-capture a device more than once per this window (coalesce + floor). */
const CACHE_MIN_INTERVAL_MS = 3_000;
/** Floor on re-encoding a donated frame. Encoding one costs ~17 ms of the event
 * loop, and a thumbnail is a glance, not a video. */
const OFFER_MIN_INTERVAL_MS = 1_000;

interface ThumbEntry {
  png: Buffer;
  at: number;
}

/**
 * Caches device thumbnails and optionally refreshes them in the background so an
 * opening browser sees a preview instantly instead of waiting ~1-2 s for a fresh
 * `screencap`.
 *
 * - The route reads through {@link get}, which is stale-while-revalidate: it
 *   returns the cached frame immediately and refreshes asynchronously, so a poll
 *   never blocks once anything is cached (only a cold device captures inline).
 * - When background prefetch is enabled, a timer captures every connected device
 *   on a fixed cadence, keeping the cache warm even while no browser is open.
 *
 * Captures are coalesced per device (one in-flight `screencap` at a time), so
 * the background loop and concurrent route reads never stack up on a device.
 */
export class ThumbnailManager {
  private readonly cache = new Map<string, ThumbEntry>();
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();
  private timer: NodeJS.Timeout | undefined;

  /** Anyone else who wants the frame this class just captured — the replay
   * recorder, which would otherwise have to screencap the same device again. */
  private onFrame: ((serial: string, frame: Frame) => void) | undefined;

  constructor(
    private readonly adbManager: AdbManager,
    /** Background prefetch cadence in ms; <= 0 disables the loop entirely. */
    private readonly backgroundIntervalMs: number,
  ) {}

  onCapture(handler: (serial: string, frame: Frame) => void): void {
    this.onFrame = handler;
  }

  start(): void {
    if (this.backgroundIntervalMs <= 0) return;
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), this.backgroundIntervalMs);
    // Never let the prefetch timer alone keep the process alive.
    this.timer.unref?.();
    console.log(`[thumbnail] background prefetch every ${Math.round(this.backgroundIntervalMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Take a frame someone else already captured and use it as the thumbnail.
   *
   * A running script screencaps every poll while this class was screencapping
   * the same device on its own timer — two ~8 MB transfers of the same picture,
   * and the expensive half of each. Donating the script's frame removes the
   * second transfer entirely *and* makes the thumbnail track whatever the script
   * is looking at, which is the more useful thing to be showing anyway.
   *
   * Cheap enough to call on every poll (~17 ms to encode against hundreds of ms
   * for a capture), but floored anyway — nobody needs a 5 fps thumbnail.
   */
  offer(serial: string, frame: { width: number; height: number; pixels: Uint8Array }): void {
    const cached = this.cache.get(serial);
    if (cached && Date.now() - cached.at < OFFER_MIN_INTERVAL_MS) return;
    try {
      this.cache.set(serial, { png: thumbnailFromFrame(frame), at: Date.now() });
    } catch {
      /* a malformed frame is not worth failing the caller's step over */
    }
  }

  /**
   * Serve a device thumbnail. Returns a cached frame instantly and revalidates
   * in the background when it is older than the floor; only a device with no
   * cached frame yet blocks on an inline capture.
   */
  async get(serial: string): Promise<Buffer | null> {
    const cached = this.cache.get(serial);
    if (cached) {
      if (Date.now() - cached.at >= CACHE_MIN_INTERVAL_MS) void this.capture(serial).catch(() => {});
      return cached.png;
    }
    return this.capture(serial);
  }

  private async refreshAll(): Promise<void> {
    const connected = this.adbManager.deviceInfos().filter((d) => d.state === "device");
    // Forget devices that dropped so their stale preview can't linger.
    const alive = new Set(connected.map((d) => d.serial));
    for (const serial of [...this.cache.keys()]) if (!alive.has(serial)) this.cache.delete(serial);

    // Skip devices a route read just refreshed; the half-interval guard also
    // absorbs capture latency so the effective cadence stays ~one interval.
    await Promise.allSettled(
      connected
        .filter((d) => this.isStale(d.serial, this.backgroundIntervalMs / 2))
        .map((d) => this.capture(d.serial)),
    );
  }

  private isStale(serial: string, maxAgeMs: number): boolean {
    const cached = this.cache.get(serial);
    return !cached || Date.now() - cached.at >= maxAgeMs;
  }

  private capture(serial: string): Promise<Buffer | null> {
    let pending = this.inFlight.get(serial);
    if (!pending) {
      pending = (async () => {
        const adb = await this.adbManager.getAdb(serial);
        const frame = await screencap(adb);
        const png = thumbnailFromFrame(frame);
        this.cache.set(serial, { png, at: Date.now() });
        // The background loop is what keeps a replay running while no script
        // is: this is the same picture, kept at a size worth looking at.
        this.onFrame?.(serial, frame);
        return png;
      })()
        .catch(() => null)
        .finally(() => this.inFlight.delete(serial));
      this.inFlight.set(serial, pending);
    }
    return pending;
  }
}
