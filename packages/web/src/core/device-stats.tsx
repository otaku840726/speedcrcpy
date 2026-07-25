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

function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function ramText(usedKb: number | null, totalKb: number | null): string {
  if (usedKb === null || totalKb === null) return "—";
  const gb = (kb: number) => (kb / 1_048_576).toFixed(1);
  return `${gb(usedKb)}/${gb(totalKb)}G`;
}

/** Warm/hot colouring for the CPU temperature chip (icon + text both tint). */
function tempColor(t: number | null): string | undefined {
  if (t === null) return undefined;
  if (t >= 65) return "var(--danger)";
  if (t >= 55) return "#f0a94b";
  return undefined;
}

/**
 * Bootstrap Icons (MIT), inlined so there is no font/dependency to load. Each
 * uses fill="currentColor", so a chip's colour tints its icon too.
 */
const Icon = ({ paths }: { paths: string[] }) => (
  <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
    {paths.map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
);

const ICONS = {
  battery: [
    "M2 6h5v4H2z",
    "M2 4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm10 1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm4 3a1.5 1.5 0 0 1-1.5 1.5v-3A1.5 1.5 0 0 1 16 8",
  ],
  temp: [
    "M9.5 12.5a1.5 1.5 0 1 1-2-1.415V6.5a.5.5 0 0 1 1 0v4.585a1.5 1.5 0 0 1 1 1.415",
    "M5.5 2.5a2.5 2.5 0 0 1 5 0v7.55a3.5 3.5 0 1 1-5 0zM8 1a1.5 1.5 0 0 0-1.5 1.5v7.987l-.167.15a2.5 2.5 0 1 0 3.333 0l-.166-.15V2.5A1.5 1.5 0 0 0 8 1",
  ],
  cpu: [
    "M5 0a.5.5 0 0 1 .5.5V2h1V.5a.5.5 0 0 1 1 0V2h1V.5a.5.5 0 0 1 1 0V2h1V.5a.5.5 0 0 1 1 0V2A2.5 2.5 0 0 1 14 4.5h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14v1h1.5a.5.5 0 0 1 0 1H14a2.5 2.5 0 0 1-2.5 2.5v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14h-1v1.5a.5.5 0 0 1-1 0V14A2.5 2.5 0 0 1 2 11.5H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2v-1H.5a.5.5 0 0 1 0-1H2A2.5 2.5 0 0 1 4.5 2V.5A.5.5 0 0 1 5 0m-.5 3A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 11.5 3zM5 6.5A1.5 1.5 0 0 1 6.5 5h3A1.5 1.5 0 0 1 11 6.5v3A1.5 1.5 0 0 1 9.5 11h-3A1.5 1.5 0 0 1 5 9.5zM6.5 6a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5z",
  ],
  gpu: [
    "M4 8a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0m7.5-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3",
    "M0 1.5A.5.5 0 0 1 .5 1h1a.5.5 0 0 1 .5.5V4h13.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H2v2.5a.5.5 0 0 1-1 0V2H.5a.5.5 0 0 1-.5-.5m5.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5M9 8a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0",
    "M3 12.5h3.5v1a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5zm4 1v-1h4v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5",
  ],
  ram: [
    "M1 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h4.586a1 1 0 0 0 .707-.293l.353-.353a.5.5 0 0 1 .708 0l.353.353a1 1 0 0 0 .707.293H15a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm.5 1h3a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5m5 0h3a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5m4.5.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5zM2 10v2H1v-2zm2 0v2H3v-2zm2 0v2H5v-2zm3 0v2H8v-2zm2 0v2h-1v-2zm2 0v2h-1v-2zm2 0v2h-1v-2z",
  ],
};

/** The five telemetry chips, shared by the device list and the session overlay. */
export function DeviceStatsChips({ stats }: { stats: DeviceStats | undefined }) {
  if (!stats) return null;
  return (
    <>
      <span className="stat-chip">
        <Icon paths={ICONS.battery} />
        {stats.battery === null ? "—" : `${stats.battery}%`}
      </span>
      <span className="stat-chip" style={{ color: tempColor(stats.cpuTemp) }}>
        <Icon paths={ICONS.temp} />
        {stats.cpuTemp === null ? "—" : `${Math.round(stats.cpuTemp)}°C`}
      </span>
      <span className="stat-chip">
        <Icon paths={ICONS.cpu} />
        {pct(stats.cpuUsage)}
      </span>
      <span className="stat-chip">
        <Icon paths={ICONS.gpu} />
        {pct(stats.gpuUsage)}
      </span>
      <span className="stat-chip">
        <Icon paths={ICONS.ram} />
        {ramText(stats.ramUsedKb, stats.ramTotalKb)}
      </span>
    </>
  );
}
