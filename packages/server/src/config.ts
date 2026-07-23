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
  /** Start every mirror session with the device's physical screen off. */
  screenOffDefault: z.coerce.boolean().default(false),
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
