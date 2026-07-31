import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(1).max(65535).default(8000),
  password: z.string().min(1),
  dataDir: z.string().default("data"),
  adbHost: z.string().default("127.0.0.1"),
  adbPort: z.coerce.number().int().default(5037),
  /**
   * Start every mirror session with the device's physical screen off.
   * Accepts a JSON boolean or an env string — note z.coerce.boolean() would
   * treat the string "false" as true (any non-empty string is truthy), so
   * parse the truthy tokens explicitly.
   */
  screenOffDefault: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1" || v === "yes"),
  /**
   * Background thumbnail prefetch cadence in seconds. The server captures a
   * preview of every connected device on this interval so an opening browser
   * sees them instantly instead of waiting for a fresh screencap. 0 disables
   * the background loop (thumbnails are then captured on request only).
   */
  thumbnailInterval: z.coerce.number().min(0).default(10),
  /**
   * How long (seconds) to keep a mirror session warm after the last viewer
   * leaves. Reattaching to a warm session is instant; a cold start takes ~2 s
   * and resets the (restored) quality. 0 keeps the session warm for as long as
   * the device stays connected — instant loads always, at the cost of the
   * device encoding video continuously even when nobody is watching.
   */
  sessionLinger: z.coerce.number().min(0).default(60),
  /**
   * How often (seconds) to poll device telemetry (battery, temperature, CPU /
   * GPU / RAM usage) for connected devices. Very light (reads a few sysfs/proc
   * files). 0 disables telemetry collection entirely.
   */
  statsInterval: z.coerce.number().min(0).default(5),
  /**
   * Video codec the device encodes. h265 cuts ~30-40% bitrate for the same
   * quality (a real win on weak networks) but needs the client to decode HEVC
   * (WebCodecs — hardware-dependent; the TinyH264 software fallback is
   * H.264-only, so insecure-context LAN clients must stay on h264).
   */
  videoCodec: z.enum(["h264", "h265"]).default("h264"),
  /**
   * Enable the experimental WebTransport (HTTP/3 over QUIC) gateway on its own
   * UDP port. Crosses TCP head-of-line blocking: each video frame rides its own
   * QUIC stream, so a lost packet no longer stalls control/audio/other frames.
   * WebSocket stays available as fallback; clients pick WT only when the browser
   * supports it and can connect. Off by default (needs an open UDP port + a
   * self-signed cert whose hash the client trusts).
   */
  wtEnabled: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1" || v === "yes"),
  /** UDP port for the WebTransport gateway (separate from the HTTP `port`). */
  wtPort: z.coerce.number().int().min(1).max(65535).default(8443),
  /**
   * Keep a timelapse of what each script run saw, from the frames the run
   * already captured (no extra screencap). Off means neither disk nor CPU is
   * touched for it.
   */
  replayEnabled: z
    .union([z.boolean(), z.string()])
    .default(true)
    .transform((v) => v !== false && v !== "false" && v !== "0" && v !== "no"),
  /** Floor between recorded frames, in seconds. */
  replayInterval: z.coerce.number().min(0.2).max(60).default(2),
  /** Ceiling on all recordings; the oldest run is evicted when it is reached. */
  replayMaxMb: z.coerce.number().int().min(10).max(20_000).default(500),
  /** Stored frame width in pixels — enough to read a button, not a whole UI. */
  replayWidth: z.coerce.number().int().min(120).max(1080).default(360),
});

export type Config = z.infer<typeof ConfigSchema> & { dataDir: string };

/**
 * Config sources, later wins: data/config.json < environment variables.
 * If no password is configured anywhere, one is generated once and persisted
 * to data/config.json (printed to the log so the user can find it).
 */
/**
 * Merge a few fields into data/config.json, leaving everything else — the
 * generated password above, in particular — untouched. For settings the UI is
 * allowed to change. An environment variable for the same field still wins at
 * the next boot, since env is applied last.
 */
export function saveConfig(patch: Record<string, unknown>): void {
  const dataDir = resolve(process.env.SPEEDCRCPY_DATA_DIR ?? "data");
  const configPath = join(dataDir, "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
      /* corrupt file — replaced rather than merged into */
    }
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ ...current, ...patch }, null, 2));
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.SPEEDCRCPY_DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true });

  const configPath = join(dataDir, "config.json");
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
  }

  const merged = {
    ...fileConfig,
    ...(process.env.SPEEDCRCPY_HOST ? { host: process.env.SPEEDCRCPY_HOST } : {}),
    ...(process.env.SPEEDCRCPY_PORT ? { port: process.env.SPEEDCRCPY_PORT } : {}),
    ...(process.env.SPEEDCRCPY_PASSWORD ? { password: process.env.SPEEDCRCPY_PASSWORD } : {}),
    ...(process.env.SPEEDCRCPY_ADB_HOST ? { adbHost: process.env.SPEEDCRCPY_ADB_HOST } : {}),
    ...(process.env.SPEEDCRCPY_ADB_PORT ? { adbPort: process.env.SPEEDCRCPY_ADB_PORT } : {}),
    ...(process.env.SPEEDCRCPY_SCREEN_OFF ? { screenOffDefault: process.env.SPEEDCRCPY_SCREEN_OFF } : {}),
    ...(process.env.SPEEDCRCPY_THUMBNAIL_INTERVAL
      ? { thumbnailInterval: process.env.SPEEDCRCPY_THUMBNAIL_INTERVAL }
      : {}),
    ...(process.env.SPEEDCRCPY_SESSION_LINGER
      ? { sessionLinger: process.env.SPEEDCRCPY_SESSION_LINGER }
      : {}),
    ...(process.env.SPEEDCRCPY_STATS_INTERVAL
      ? { statsInterval: process.env.SPEEDCRCPY_STATS_INTERVAL }
      : {}),
    ...(process.env.SPEEDCRCPY_VIDEO_CODEC ? { videoCodec: process.env.SPEEDCRCPY_VIDEO_CODEC } : {}),
    ...(process.env.SPEEDCRCPY_WT_ENABLED ? { wtEnabled: process.env.SPEEDCRCPY_WT_ENABLED } : {}),
    ...(process.env.SPEEDCRCPY_WT_PORT ? { wtPort: process.env.SPEEDCRCPY_WT_PORT } : {}),
    ...(process.env.SPEEDCRCPY_REPLAY ? { replayEnabled: process.env.SPEEDCRCPY_REPLAY } : {}),
    ...(process.env.SPEEDCRCPY_REPLAY_INTERVAL ? { replayInterval: process.env.SPEEDCRCPY_REPLAY_INTERVAL } : {}),
    ...(process.env.SPEEDCRCPY_REPLAY_MAX_MB ? { replayMaxMb: process.env.SPEEDCRCPY_REPLAY_MAX_MB } : {}),
  };

  if (typeof merged.password !== "string" || merged.password.length === 0) {
    const generated = randomBytes(9).toString("base64url");
    merged.password = generated;
    writeFileSync(configPath, JSON.stringify({ ...fileConfig, password: generated }, null, 2));
    console.warn(`[config] No password configured — generated one and saved to ${configPath}`);
    console.warn(`[config] Login password: ${generated}`);
  }

  return { ...ConfigSchema.parse(merged), dataDir };
}
