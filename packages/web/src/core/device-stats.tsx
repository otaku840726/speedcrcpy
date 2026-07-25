import type { DeviceStats } from "@speedcrcpy/shared";
import { useEffect, useState } from "react";

const STATS_REFRESH_MS = 5000;

/** Poll a device's telemetry every 5 s (paused while the tab is hidden). */
export function useDeviceStats(serial: string | undefined): DeviceStats | undefined {
  const [stats, setStats] = useState<DeviceStats | undefined>();

  useEffect(() => {
    if (!serial) {
      setStats(undefined);
      return;
    }
    let cancelled = false;
    setStats(undefined);
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/devices/${encodeURIComponent(serial)}/stats`);
        if (res.status === 204 || !res.ok) return; // 204 = not sampled yet
        const data = (await res.json()) as DeviceStats;
        if (!cancelled) setStats(data);
      } catch {
        // Transient fetch failure — keep the last snapshot.
      }
    };
    void load();
    const id = window.setInterval(load, STATS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [serial]);

  return stats;
}

function pct(value: number | null, label: string): string {
  return `${label} ${value === null ? "—" : `${value}%`}`;
}

function ramText(usedKb: number | null, totalKb: number | null): string {
  if (usedKb === null || totalKb === null) return "RAM —";
  const gb = (kb: number) => (kb / 1_048_576).toFixed(1);
  return `RAM ${gb(usedKb)}/${gb(totalKb)}G`;
}

/** Warm/hot colouring for the CPU temperature chip. */
function tempColor(t: number | null): string | undefined {
  if (t === null) return undefined;
  if (t >= 65) return "var(--danger)";
  if (t >= 55) return "#f0a94b";
  return undefined;
}

/** The five telemetry chips, shared by the device list and the session overlay. */
export function DeviceStatsChips({ stats }: { stats: DeviceStats | undefined }) {
  if (!stats) return null;
  return (
    <>
      <span>🔋 {stats.battery === null ? "—" : `${stats.battery}%`}</span>
      <span style={{ color: tempColor(stats.cpuTemp) }}>
        {stats.cpuTemp === null ? "—" : `${Math.round(stats.cpuTemp)}°C`}
      </span>
      <span>{pct(stats.cpuUsage, "CPU")}</span>
      <span>{pct(stats.gpuUsage, "GPU")}</span>
      <span>{ramText(stats.ramUsedKb, stats.ramTotalKb)}</span>
    </>
  );
}
