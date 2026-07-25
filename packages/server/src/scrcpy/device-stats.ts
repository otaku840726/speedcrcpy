import type { DeviceStats } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import type { AdbManager } from "../adb/adb-manager.js";

/**
 * One shell round-trip reads everything: battery level, every thermal zone
 * (type + temp, paired by index server-side), the Qualcomm GPU busy counter,
 * memory totals, and the aggregate CPU jiffies. Sections are delimited so the
 * parser never depends on device-specific ordering.
 */
const PROBE = [
  'echo "==TYPES=="',
  "cat /sys/class/thermal/thermal_zone*/type 2>/dev/null",
  'echo "==TEMPS=="',
  "cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null",
  'echo "==LVL=="',
  'dumpsys battery 2>/dev/null | grep -m1 " level:"',
  'echo "==GPU=="',
  "cat /sys/class/kgsl/kgsl-3d0/gpubusy 2>/dev/null",
  'echo "==MEM=="',
  "grep -E '^MemTotal|^MemAvailable' /proc/meminfo",
  'echo "==CPU=="',
  "head -1 /proc/stat",
].join("\n");

/** Ignore obviously bogus thermal readings (broken sensors report extremes). */
const MAX_SANE_MILLI_C = 150_000;

interface CpuSample {
  total: number;
  idle: number;
}

/**
 * Polls lightweight device telemetry (battery / temperature / CPU / GPU / RAM)
 * on a fixed cadence for every connected device and caches the latest snapshot.
 * Far cheaper than the thumbnail screencap — it only reads a few sysfs/proc
 * files — so it can run continuously; the routes serve the cache.
 */
export class DeviceStatsManager {
  private readonly cache = new Map<string, DeviceStats>();
  private readonly prevCpu = new Map<string, CpuSample>();
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly adbManager: AdbManager,
    /** Poll cadence in ms; <= 0 disables telemetry entirely. */
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs <= 0) return;
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), this.intervalMs);
    this.timer.unref?.();
    console.log(`[stats] device telemetry every ${Math.round(this.intervalMs / 1000)}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(serial: string): DeviceStats | undefined {
    return this.cache.get(serial);
  }

  private async refreshAll(): Promise<void> {
    const connected = this.adbManager.deviceInfos().filter((d) => d.state === "device");
    const alive = new Set(connected.map((d) => d.serial));
    for (const serial of [...this.cache.keys()]) {
      if (!alive.has(serial)) {
        this.cache.delete(serial);
        this.prevCpu.delete(serial);
      }
    }
    await Promise.allSettled(connected.map((d) => this.sample(d.serial)));
  }

  private async sample(serial: string): Promise<void> {
    if (this.inFlight.has(serial)) return;
    this.inFlight.add(serial);
    try {
      const adb = await this.adbManager.getAdb(serial);
      const shell = adb.subprocess.shellProtocol;
      if (!shell?.isSupported) return;
      const { stdout, exitCode } = await shell.spawnWait(PROBE);
      if (exitCode !== 0) return;
      const stats = this.parse(serial, new TextDecoder().decode(stdout));
      this.cache.set(serial, stats);
    } catch {
      // Device busy/dropped mid-read — keep the previous snapshot.
    } finally {
      this.inFlight.delete(serial);
    }
  }

  private parse(serial: string, text: string): DeviceStats {
    const sections: Record<string, string[]> = {};
    let cur = "";
    for (const line of text.split("\n")) {
      const marker = line.match(/^==(\w+)==$/);
      if (marker) {
        cur = marker[1]!;
        sections[cur] = [];
      } else if (cur) {
        sections[cur]!.push(line);
      }
    }

    return {
      battery: this.parseBattery(sections.LVL),
      cpuTemp: this.parseCpuTemp(sections.TYPES, sections.TEMPS),
      cpuUsage: this.parseCpuUsage(serial, sections.CPU),
      gpuUsage: this.parseGpuUsage(sections.GPU),
      ...this.parseMem(sections.MEM),
    };
  }

  private parseBattery(lines: string[] | undefined): number | null {
    const m = lines?.join(" ").match(/level:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  private parseCpuTemp(types: string[] | undefined, temps: string[] | undefined): number | null {
    if (!types || !temps) return null;
    let maxMilli = 0;
    const n = Math.min(types.length, temps.length);
    for (let i = 0; i < n; i++) {
      if (!/cpu/i.test(types[i]!)) continue;
      const milli = Number(temps[i]);
      if (Number.isFinite(milli) && milli > 0 && milli < MAX_SANE_MILLI_C && milli > maxMilli) {
        maxMilli = milli;
      }
    }
    return maxMilli > 0 ? Math.round(maxMilli / 100) / 10 : null;
  }

  private parseGpuUsage(lines: string[] | undefined): number | null {
    const parts = lines?.join(" ").trim().split(/\s+/) ?? [];
    if (parts.length < 2) return null;
    const busy = Number(parts[0]);
    const total = Number(parts[1]);
    if (!Number.isFinite(busy) || !Number.isFinite(total) || total <= 0) return null;
    return Math.min(100, Math.round((busy / total) * 100));
  }

  private parseMem(lines: string[] | undefined): { ramUsedKb: number | null; ramTotalKb: number | null } {
    let total: number | null = null;
    let avail: number | null = null;
    for (const line of lines ?? []) {
      const m = line.match(/^(MemTotal|MemAvailable):\s*(\d+)/);
      if (m?.[1] === "MemTotal") total = Number(m[2]);
      else if (m?.[1] === "MemAvailable") avail = Number(m[2]);
    }
    if (total === null || avail === null) return { ramUsedKb: null, ramTotalKb: total };
    return { ramUsedKb: Math.max(0, total - avail), ramTotalKb: total };
  }

  private parseCpuUsage(serial: string, lines: string[] | undefined): number | null {
    const fields = lines?.[0]?.trim().split(/\s+/) ?? [];
    if (fields[0] !== "cpu" || fields.length < 6) return null;
    const nums = fields.slice(1).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const total = nums.reduce((a, b) => a + b, 0);
    const idle = nums[3]! + nums[4]!; // idle + iowait
    const prev = this.prevCpu.get(serial);
    this.prevCpu.set(serial, { total, idle });
    if (!prev) return null;
    const dTotal = total - prev.total;
    const dIdle = idle - prev.idle;
    if (dTotal <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
  }
}
