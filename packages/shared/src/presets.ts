export interface QualityPreset {
  id: string;
  label: string;
  /** scrcpy maxSize: longer side cap in px, 0 = native */
  maxSize: number;
  videoBitRate: number;
  maxFps: number;
}

/** Quality ladder, best to worst. Auto-adaptation steps along this array. */
export const QUALITY_LADDER: readonly QualityPreset[] = [
  { id: "p0", label: "1440p / 10 Mbps / 60", maxSize: 2560, videoBitRate: 10_000_000, maxFps: 60 },
  { id: "p1", label: "1080p / 8 Mbps / 60", maxSize: 1920, videoBitRate: 8_000_000, maxFps: 60 },
  { id: "p2", label: "720p / 4 Mbps / 60", maxSize: 1280, videoBitRate: 4_000_000, maxFps: 60 },
  { id: "p3", label: "720p / 2 Mbps / 30", maxSize: 1280, videoBitRate: 2_000_000, maxFps: 30 },
  { id: "p4", label: "540p / 1 Mbps / 30", maxSize: 960, videoBitRate: 1_000_000, maxFps: 30 },
  { id: "p5", label: "360p / 300 kbps / 15", maxSize: 640, videoBitRate: 300_000, maxFps: 15 },
] as const;

export const DEFAULT_PRESET_ID = "p2";

export function presetById(id: string): QualityPreset | undefined {
  return QUALITY_LADDER.find((p) => p.id === id);
}

export function presetIndex(id: string): number {
  return QUALITY_LADDER.findIndex((p) => p.id === id);
}
