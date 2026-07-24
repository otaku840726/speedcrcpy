/** The three encoder parameters the user can set independently in manual mode. */
export interface QualitySettings {
  /** scrcpy maxSize: longer side cap in px, 0 = native (no scaling). */
  maxSize: number;
  videoBitRate: number;
  maxFps: number;
}

/** Fixed option lists for the manual quality selectors (UI + validation). */
export const RESOLUTION_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: "原生" },
  { value: 2560, label: "1440p" },
  { value: 1920, label: "1080p" },
  { value: 1600, label: "900p" },
  { value: 1280, label: "720p" },
  { value: 960, label: "540p" },
  { value: 640, label: "360p" },
  { value: 480, label: "270p" },
];

export const BITRATE_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 300_000, label: "0.3 Mbps" },
  { value: 500_000, label: "0.5 Mbps" },
  { value: 1_000_000, label: "1 Mbps" },
  { value: 2_000_000, label: "2 Mbps" },
  { value: 4_000_000, label: "4 Mbps" },
  { value: 6_000_000, label: "6 Mbps" },
  { value: 8_000_000, label: "8 Mbps" },
  { value: 10_000_000, label: "10 Mbps" },
  { value: 16_000_000, label: "16 Mbps" },
  { value: 20_000_000, label: "20 Mbps" },
];

export const FPS_OPTIONS: readonly number[] = [15, 24, 30, 45, 60, 90, 120];

export const DEFAULT_QUALITY: QualitySettings = { maxSize: 1280, videoBitRate: 4_000_000, maxFps: 60 };

/** Auto-adaptation ladder (best to worst); the congestion controller steps it. */
export const QUALITY_LADDER: readonly QualitySettings[] = [
  { maxSize: 2560, videoBitRate: 10_000_000, maxFps: 60 },
  { maxSize: 1920, videoBitRate: 8_000_000, maxFps: 60 },
  { maxSize: 1280, videoBitRate: 4_000_000, maxFps: 60 },
  { maxSize: 1280, videoBitRate: 2_000_000, maxFps: 30 },
  { maxSize: 960, videoBitRate: 1_000_000, maxFps: 30 },
  { maxSize: 640, videoBitRate: 300_000, maxFps: 15 },
];

/** Default starting rung for auto mode. */
export const DEFAULT_LADDER_INDEX = 2;

/** Nearest ladder rung to arbitrary settings, matched by bitrate. */
export function nearestLadderIndex(quality: QualitySettings): number {
  let best = 0;
  let bestDiff = Infinity;
  QUALITY_LADDER.forEach((rung, i) => {
    const diff = Math.abs(rung.videoBitRate - quality.videoBitRate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  });
  return best;
}

export function sameQuality(a: QualitySettings, b: QualitySettings): boolean {
  return a.maxSize === b.maxSize && a.videoBitRate === b.videoBitRate && a.maxFps === b.maxFps;
}

export function qualityLabel(q: QualitySettings): string {
  const res = RESOLUTION_OPTIONS.find((r) => r.value === q.maxSize)?.label ?? `${q.maxSize}px`;
  return `${res} · ${(q.videoBitRate / 1_000_000).toFixed(q.videoBitRate < 1_000_000 ? 1 : 0)}M · ${q.maxFps}fps`;
}
