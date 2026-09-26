import type { Adb } from "@yume-chan/adb";
import aapt from "aaptjs3";
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { getApkPath } from "./apps.js";

export interface AppMetadata {
  label: string;
  iconPath?: string;
  hasIcon?: boolean;
  updatedAt: number;
}

const memoryCache = new Map<string, AppMetadata>();
let metadataDir = "";

export function initAppMetadata(dataDir: string): void {
  metadataDir = join(dataDir, "app-metadata");
  try {
    mkdirSync(metadataDir, { recursive: true });

    // Pre-load cached labels and icons into memory
    const files = readdirSync(metadataDir);
    for (const f of files) {
      if (f.endsWith(".json")) {
        const pkg = f.slice(0, -5);
        try {
          const raw = readFileSync(join(metadataDir, f), "utf8");
          const data = JSON.parse(raw) as AppMetadata;
          data.hasIcon = existsSync(join(metadataDir, `${pkg}.png`));
          memoryCache.set(pkg, data);
        } catch {
          /* ignore corrupt file */
        }
      }
    }
  } catch (err) {
    console.warn("[app-metadata] initAppMetadata failed:", err);
  }
}

export function getCachedAppLabel(packageName: string): string | undefined {
  return memoryCache.get(packageName)?.label;
}

export function hasCachedAppIcon(packageName: string): boolean {
  if (memoryCache.get(packageName)?.hasIcon) return true;
  if (!metadataDir) return false;
  return existsSync(join(metadataDir, `${packageName}.png`));
}

export function getCachedAppIconFile(packageName: string): string | undefined {
  if (!metadataDir) return undefined;
  const iconFile = join(metadataDir, `${packageName}.png`);
  return existsSync(iconFile) ? iconFile : undefined;
}

async function getBinaryFromDevice(adb: Adb, args: string[]): Promise<Buffer> {
  const p = await adb.subprocess.shellProtocol.spawn(args);
  const chunks: Uint8Array[] = [];
  const reader = p.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function resolveAppMetadata(
  adb: Adb,
  packageName: string,
  knownApkPath?: string,
): Promise<{ label: string; iconBuffer?: Buffer }> {
  // Check memory / disk cache
  const cached = memoryCache.get(packageName);
  const iconPath = metadataDir ? join(metadataDir, `${packageName}.png`) : "";
  if (cached && iconPath && existsSync(iconPath)) {
    return {
      label: cached.label,
      iconBuffer: readFileSync(iconPath),
    };
  }

  const apkPath = knownApkPath || (await getApkPath(adb, packageName));
  if (!apkPath) {
    throw new Error(`找不到套件 ${packageName} 的 APK 路徑`);
  }

  // Extract AndroidManifest.xml and resources.arsc from device
  const manifestBuf = await getBinaryFromDevice(adb, ["unzip", "-p", apkPath, "AndroidManifest.xml"]);
  if (manifestBuf.length === 0) {
    throw new Error(`無法解開 ${packageName} 的 AndroidManifest.xml`);
  }

  const arscBuf = await getBinaryFromDevice(adb, ["unzip", "-p", apkPath, "resources.arsc"]).catch(
    () => Buffer.alloc(0),
  );

  const zip = new AdmZip();
  zip.addFile("AndroidManifest.xml", manifestBuf);
  if (arscBuf.length > 0) {
    zip.addFile("resources.arsc", arscBuf);
  }

  const tmpFile = join(
    os.tmpdir(),
    `skel_${packageName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.apk`,
  );
  zip.writeZip(tmpFile);

  let label = packageName;
  let targetIconPath = "";

  try {
    const { stdout } = await aapt.dump(tmpFile, "badging");
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (
        line.startsWith("application-label-zh-TW:") ||
        line.startsWith("application-label-zh-CN:") ||
        line.startsWith("application-label-zh:") ||
        (label === packageName && line.startsWith("application-label:"))
      ) {
        const parts = line.split(":", 2);
        if (parts[1]) {
          label = parts[1].replace(/^'|'$/g, "").trim();
        }
      }
      if (line.startsWith("application: ") && line.includes("icon='")) {
        const m = line.match(/icon='([^']+)'/);
        if (m) targetIconPath = m[1];
      }
    }
  } catch (err) {
    console.warn(`[app-metadata] aapt dump failed for ${packageName}:`, err);
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }

  // Extract icon
  let iconBuffer: Buffer | undefined;
  if (targetIconPath && (targetIconPath.endsWith(".png") || targetIconPath.endsWith(".webp"))) {
    try {
      const buf = await getBinaryFromDevice(adb, ["unzip", "-p", apkPath, targetIconPath]);
      if (buf.length > 0) iconBuffer = buf;
    } catch {
      /* fallback below */
    }
  }

  // If no icon yet (e.g. adaptive icon XML), search APK list for best png icon
  if (!iconBuffer) {
    try {
      const p = await adb.subprocess.shellProtocol.spawn(["unzip", "-l", apkPath]);
      const dec = new TextDecoder();
      let list = "";
      const r = p.stdout.getReader();
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        list += dec.decode(value);
      }
      const lines = list.split("\n");
      const pngs = lines
        .map((l) => l.trim().split(/\s+/)[3])
        .filter((f): f is string => Boolean(f && (f.endsWith(".png") || f.endsWith(".webp"))));

      const launcherCandidates = pngs.filter(
        (f) => (f.includes("ic_launcher") || f.includes("icon")) && !f.includes("background"),
      );

      const candidate =
        launcherCandidates.find((f) => f.includes("xxhdpi")) ||
        launcherCandidates.find((f) => f.includes("xhdpi")) ||
        launcherCandidates.find((f) => f.includes("hdpi")) ||
        launcherCandidates[launcherCandidates.length - 1] ||
        pngs.find((f) => f.includes("app_icon") || f.includes("logo")) ||
        pngs[0];

      if (candidate) {
        const buf = await getBinaryFromDevice(adb, ["unzip", "-p", apkPath, candidate]);
        if (buf.length > 0) iconBuffer = buf;
      }
    } catch {
      /* ignore */
    }
  }

  // Save to cache
  const metadata: AppMetadata = {
    label,
    iconPath: targetIconPath || undefined,
    hasIcon: Boolean(iconBuffer && iconBuffer.length > 0),
    updatedAt: Date.now(),
  };
  memoryCache.set(packageName, metadata);

  if (metadataDir) {
    try {
      writeFileSync(join(metadataDir, `${packageName}.json`), JSON.stringify(metadata, null, 2));
      if (iconBuffer && iconBuffer.length > 0) {
        writeFileSync(join(metadataDir, `${packageName}.png`), iconBuffer);
      }
    } catch (err) {
      console.warn(`[app-metadata] Failed to save cache for ${packageName}:`, err);
    }
  }

  return { label, iconBuffer };
}

/**
 * Resolve metadata for a list of apps in parallel with concurrency limit.
 */
export async function resolveAppsMetadataBatch(
  adb: Adb,
  apps: { packageName: string; apkPath?: string }[],
  concurrency = 4,
): Promise<void> {
  const uncached = apps.filter((a) => !memoryCache.has(a.packageName));
  if (uncached.length === 0) return;

  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, uncached.length) }, async () => {
    while (index < uncached.length) {
      const current = uncached[index++];
      if (!current) break;
      try {
        await resolveAppMetadata(adb, current.packageName, current.apkPath);
      } catch (err) {
        // Continue with other apps even if one fails
      }
    }
  });

  await Promise.all(workers);
}
