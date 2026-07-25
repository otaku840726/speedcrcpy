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
});

export type Config = z.infer<typeof ConfigSchema> & { dataDir: string };

/**
 * Config sources, later wins: data/config.json < environment variables.
 * If no password is configured anywhere, one is generated once and persisted
 * to data/config.json (printed to the log so the user can find it).
 */
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
