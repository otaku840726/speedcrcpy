import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import type { AdbManager } from "./adb/adb-manager.js";
import type { SessionManager } from "./scrcpy/session-manager.js";
import type { ReplayStore } from "./scripts/replay-store.js";
import { visionStatus } from "./scripts/vision-offload.js";
import * as vision from "./scripts/vision.js";

/** Normal cadence: every 1 minute for high-resolution historical telemetry. */
const NORMAL_CADENCE_MS = 60_000;
/** Urgent cadence: every 15 seconds when memory pressure exceeds 70% of heap limit. */
const URGENT_CADENCE_MS = 15_000;
/** Max size of health.log before rotating to health.log.1 (10 MB). */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
/** Memory warning threshold (fraction of heap_size_limit). */
const MEMORY_WARN_RATIO = 0.7;

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

let activeLogFile: string | undefined;

function rotateLogIfNeeded(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      const stats = statSync(filePath);
      if (stats.size > MAX_LOG_SIZE_BYTES) {
        const backupPath = `${filePath}.1`;
        renameSync(filePath, backupPath);
      }
    }
  } catch {
    /* ignore rotation errors */
  }
}

function appendToHealthLog(filePath: string, line: string): void {
  try {
    rotateLogIfNeeded(filePath);
    appendFileSync(filePath, `${line}\n`, "utf8");
  } catch (error) {
    console.error(`[health] failed to write to ${filePath}:`, error);
  }
}

/**
 * Reads recent lines from health.log for API / diagnostic inspection.
 */
export function getRecentHealthLogs(dataDir: string, maxLines = 200): string[] {
  const filePath = join(dataDir, "health.log");
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

export function startHealthLog(
  dataDir: string,
  adbManager: AdbManager,
  sessionManager: SessionManager,
  replayStore: ReplayStore,
): void {
  mkdirSync(dataDir, { recursive: true });
  const logFile = join(dataDir, "health.log");
  activeLogFile = logFile;

  const heapStats = v8.getHeapStatistics();
  const heapLimitMb = mb(heapStats.heap_size_limit);

  const initLine =
    `[${new Date().toISOString()}] [health] Monitoring initialized. pid=${process.pid} ` +
    `node=${process.version} heapLimit=${heapLimitMb}MB logFile=${logFile}`;
  console.log(initLine);
  appendToHealthLog(logFile, initLine);

  let timer: NodeJS.Timeout | undefined;
  let isUnderPressure = false;

  const tick = async () => {
    const memory = process.memoryUsage();
    const heapUsedMb = mb(memory.heapUsed);
    const heapTotalMb = mb(memory.heapTotal);
    const rssMb = mb(memory.rss);
    const extMb = mb(memory.external);
    const abMb = mb(memory.arrayBuffers);
    const heapPct = Math.round((memory.heapUsed / heapStats.heap_size_limit) * 100);

    const sessions = await sessionManager.listConnections().catch(() => []);
    const viewers = sessions.reduce((n, s) => n + s.viewers.length, 0);
    const wtViewers = sessions.reduce((n, s) => n + s.viewers.filter((v) => v.transport === "webtransport").length, 0);
    const replay = replayStore.counts();
    const adb = adbManager.counts();
    const offload = visionStatus();
    const uptimeMinutes = Math.round(process.uptime() / 60);

    const line =
      `[${new Date().toISOString()}] [health] up=${uptimeMinutes}m | ` +
      `rss=${rssMb}MB heap=${heapUsedMb}/${heapTotalMb}MB (limit=${heapLimitMb}MB, ${heapPct}%) ` +
      `ext=${extMb}MB ab=${abMb}MB | ` +
      `adbSockets=${adb.openSockets} (created=${adb.totalSocketsCreated} closed=${adb.totalSocketsClosed}) cached=${adb.adbCached} | ` +
      `sessions=${sessions.length} viewers=${viewers}${wtViewers > 0 ? ` (wt=${wtViewers})` : ""} | ` +
      `replay shots=${replay.shots} events=${replay.events} | ` +
      `caps=${vision.capturesServed} vision=${offload.callsServed} pending=${offload.pending}`;

    console.log(line);
    appendToHealthLog(logFile, line);

    // High memory warning
    const currentRatio = memory.heapUsed / heapStats.heap_size_limit;
    if (currentRatio > MEMORY_WARN_RATIO) {
      isUnderPressure = true;
      const spaces = v8
        .getHeapSpaceStatistics()
        .map((s) => `${s.space_name}=${mb(s.space_used_size)}MB`)
        .join(" ");
      const warnLine =
        `[${new Date().toISOString()}] [WARN] Memory pressure high (${heapPct}% of limit)! ` +
        `heapUsed=${heapUsedMb}MB spaces=[${spaces}]`;
      console.warn(warnLine);
      appendToHealthLog(logFile, warnLine);
    } else {
      isUnderPressure = false;
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (timer) clearTimeout(timer);
    const delayMs = isUnderPressure ? URGENT_CADENCE_MS : NORMAL_CADENCE_MS;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref?.();
  };

  // Immediate first tick
  void tick();

  // Safety net: capture fatal crashes or shutdown directly into /data/health.log
  process.on("uncaughtException", (error) => {
    if (activeLogFile) {
      const mem = process.memoryUsage();
      const crashLine =
        `[${new Date().toISOString()}] [FATAL] uncaughtException: ${error.message}\n` +
        `Stack: ${error.stack}\n` +
        `Memory at crash: rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ext=${mb(mem.external)}MB ab=${mb(mem.arrayBuffers)}MB`;
      appendToHealthLog(activeLogFile, crashLine);
    }
  });

  process.on("unhandledRejection", (reason) => {
    if (activeLogFile) {
      const mem = process.memoryUsage();
      const rejectionLine =
        `[${new Date().toISOString()}] [WARN] unhandledRejection: ${String(reason)}\n` +
        `Memory: rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB`;
      appendToHealthLog(activeLogFile, rejectionLine);
    }
  });
}
