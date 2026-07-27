import type { DisplayInfo } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdbManager } from "../adb/adb-manager.js";

export interface DisplayOverride {
  width: number;
  height: number;
  density: number;
}

const decoder = new TextDecoder();

async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout } = await shell.spawnWait(command);
  return decoder.decode(stdout);
}

/** Read the device's native display size/density and any active override. */
async function readWm(adb: Adb): Promise<DisplayInfo> {
  const size = await sh(adb, "wm size");
  const density = await sh(adb, "wm density");
  const phys = size.match(/Physical size:\s*(\d+)x(\d+)/);
  const ovrS = size.match(/Override size:\s*(\d+)x(\d+)/);
  const physD = density.match(/Physical density:\s*(\d+)/);
  const ovrD = density.match(/Override density:\s*(\d+)/);
  if (!phys || !physD) throw new Error("could not read wm size/density");

  const nativeWidth = Number(phys[1]);
  const nativeHeight = Number(phys[2]);
  const nativeDensity = Number(physD[1]);
  const override = ovrS
    ? { width: Number(ovrS[1]), height: Number(ovrS[2]), density: ovrD ? Number(ovrD[1]) : nativeDensity }
    : null;
  return { nativeWidth, nativeHeight, nativeDensity, override };
}

/**
 * Per-device display-resolution override via `wm size` / `wm density`.
 * Overrides are persisted and re-applied when a session starts (a device
 * reboot clears `wm` overrides), so an unusually tall phone can be reshaped
 * once and stay that way. Setting a dimension equal to native resets it, so
 * the device never carries a redundant override.
 */
export class DisplayManager {
  private readonly path: string;
  private readonly overrides = new Map<string, DisplayOverride>();

  constructor(
    private readonly adbManager: AdbManager,
    dataDir: string,
  ) {
    this.path = join(dataDir, "display-overrides.json");
    if (existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, DisplayOverride>;
        for (const [serial, o] of Object.entries(stored)) this.overrides.set(serial, o);
      } catch {
        /* corrupt file — start empty */
      }
    }
  }

  stored(serial: string): DisplayOverride | undefined {
    return this.overrides.get(serial);
  }

  async info(serial: string): Promise<DisplayInfo> {
    return readWm(await this.adbManager.getAdb(serial));
  }

  /** Apply an override (resetting any dimension that equals native), persist it. */
  async apply(serial: string, want: DisplayOverride): Promise<void> {
    const adb = await this.adbManager.getAdb(serial);
    const native = await readWm(adb);

    if (want.width === native.nativeWidth && want.height === native.nativeHeight) {
      await sh(adb, "wm size reset");
    } else {
      await sh(adb, `wm size ${want.width}x${want.height}`);
    }
    if (want.density === native.nativeDensity) {
      await sh(adb, "wm density reset");
    } else {
      await sh(adb, `wm density ${want.density}`);
    }

    if (want.width === native.nativeWidth && want.height === native.nativeHeight && want.density === native.nativeDensity) {
      this.overrides.delete(serial);
    } else {
      this.overrides.set(serial, want);
    }
    this.save();
  }

  async reset(serial: string): Promise<void> {
    const adb = await this.adbManager.getAdb(serial);
    await sh(adb, "wm size reset");
    await sh(adb, "wm density reset");
    this.overrides.delete(serial);
    this.save();
  }

  /** Re-apply the stored override (called on session start; no-op if none). */
  async reapplyStored(serial: string): Promise<void> {
    const want = this.overrides.get(serial);
    if (!want) return;
    const adb = await this.adbManager.getAdb(serial);
    await sh(adb, `wm size ${want.width}x${want.height}`);
    await sh(adb, `wm density ${want.density}`);
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.overrides), null, 2));
  }
}
