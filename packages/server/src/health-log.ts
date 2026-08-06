import type { AdbManager } from "./adb/adb-manager.js";
import type { SessionManager } from "./scrcpy/session-manager.js";
import type { ReplayStore } from "./scripts/replay-store.js";
import { visionStatus } from "./scripts/vision-offload.js";
import * as vision from "./scripts/vision.js";

/**
 * One line, every few minutes, saying how much memory is held and by what.
 *
 * Written because the server died of a full JS heap after twenty hours and
 * nothing in the log said which of its structures had been growing. Reading the
 * code found no unbounded list — every one of them has a cap or a prune — so
 * the next crash needs evidence rather than another reading of the same files.
 * The counters are the suspects: each is meant to sit still, and the one that
 * climbs with `heap` is the answer.
 *
 * Cheap enough to leave on: a handful of `.size` reads and one `memoryUsage()`.
 */
const EVERY_MS = 5 * 60_000;

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

export function startHealthLog(
  adbManager: AdbManager,
  sessionManager: SessionManager,
  replayStore: ReplayStore,
): void {
  const tick = async () => {
    const memory = process.memoryUsage();
    const sessions = await sessionManager.listConnections().catch(() => []);
    const viewers = sessions.reduce((n, s) => n + s.viewers.length, 0);
    const replay = replayStore.counts();
    const adb = adbManager.counts();
    const offload = visionStatus();
    console.log(
      `[health] up=${Math.round(process.uptime() / 60)}m ` +
        `rss=${mb(memory.rss)}MB heap=${mb(memory.heapUsed)}/${mb(memory.heapTotal)}MB ` +
        `ext=${mb(memory.external)}MB ab=${mb(memory.arrayBuffers)}MB | ` +
        `sessions=${sessions.length} viewers=${viewers} | ` +
        `replay shots=${replay.shots} events=${replay.events} | ` +
        `caps=${vision.capturesServed} ` +
        `vision pending=${offload.pending} served=${offload.callsServed} | ` +
        `adb listeners=${adb.listeners} cached=${adb.adbCached}`,
    );
  };

  void tick();
  // Never the reason the process stays alive.
  setInterval(() => void tick(), EVERY_MS).unref();
}
