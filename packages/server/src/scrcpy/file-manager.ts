import type { DeviceFileItem, DeviceFileListResponse } from "@speedcrcpy/shared";
import { LinuxFileType, type Adb } from "@yume-chan/adb";
import { posix } from "node:path";

const decoder = new TextDecoder();

async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout } = await shell.spawnWait(command);
  return decoder.decode(stdout);
}

function escapeShell(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function normalizeDevicePath(rawPath?: string): string {
  if (!rawPath || !rawPath.trim()) return "/sdcard";
  const normalized = posix.normalize(rawPath.trim());
  return normalized.startsWith("/") ? normalized : "/" + normalized;
}

export async function listFiles(adb: Adb, targetPath: string): Promise<DeviceFileListResponse> {
  const currentPath = normalizeDevicePath(targetPath);
  const parentPath = currentPath === "/" ? null : posix.dirname(currentPath);

  const sync = await adb.sync();
  try {
    const entries = await sync.readdir(currentPath);
    const items: DeviceFileItem[] = [];

    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;

      const isDir = entry.type === LinuxFileType.Directory;
      const isFile = entry.type === LinuxFileType.File;
      const isLink = entry.type === LinuxFileType.Link;

      const fullPath = posix.join(currentPath, entry.name);
      const dotIndex = entry.name.lastIndexOf(".");
      const extension = !isDir && dotIndex > 0 ? entry.name.slice(dotIndex + 1).toLowerCase() : undefined;

      items.push({
        name: entry.name,
        path: fullPath,
        isDir,
        isFile,
        isLink,
        size: Number(entry.size),
        mtime: Number(entry.mtime) * 1000,
        extension,
      });
    }

    // Sort: directories first (alphabetical), then files (alphabetical)
    items.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

    return {
      currentPath,
      parentPath,
      items,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`無法讀取目錄 (${currentPath}): ${msg}`);
  } finally {
    await sync.dispose().catch(() => {});
  }
}

export async function getReadFileStream(
  adb: Adb,
  filePath: string,
): Promise<{ stream: any; dispose: () => Promise<void> }> {
  const target = normalizeDevicePath(filePath);
  const sync = await adb.sync();
  let disposed = false;
  const dispose = async () => {
    if (!disposed) {
      disposed = true;
      await sync.dispose().catch(() => {});
    }
  };

  try {
    const stream = sync.read(target);
    return { stream, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function writeDeviceFile(
  adb: Adb,
  filePath: string,
  stream: ReadableStream<Uint8Array> | any,
  mtime?: number,
): Promise<void> {
  const target = normalizeDevicePath(filePath);
  const sync = await adb.sync();
  try {
    await sync.write({
      filename: target,
      file: stream as any,
      mtime: mtime ? Math.floor(mtime / 1000) : Math.floor(Date.now() / 1000),
    });
  } finally {
    await sync.dispose().catch(() => {});
  }
}

export async function makeDirectory(adb: Adb, dirPath: string): Promise<void> {
  const target = normalizeDevicePath(dirPath);
  if (target === "/") throw new Error("無效的目錄路徑");
  const output = await sh(adb, `mkdir -p ${escapeShell(target)}`);
  if (output && output.toLowerCase().includes("error")) {
    throw new Error(output.trim());
  }
}

export async function removePath(adb: Adb, targetPath: string): Promise<void> {
  const target = normalizeDevicePath(targetPath);
  if (target === "/" || target === "/sdcard" || target === "/storage/emulated/0") {
    throw new Error("禁止刪除系統根目錄或儲存空間根目錄");
  }
  const output = await sh(adb, `rm -rf ${escapeShell(target)}`);
  if (output && output.toLowerCase().includes("error")) {
    throw new Error(output.trim());
  }
}

export async function moveOrRenamePath(adb: Adb, srcPath: string, destPath: string): Promise<void> {
  const src = normalizeDevicePath(srcPath);
  const dest = normalizeDevicePath(destPath);
  if (src === "/" || dest === "/") throw new Error("無效的路徑");
  const output = await sh(adb, `mv ${escapeShell(src)} ${escapeShell(dest)}`);
  if (output && output.toLowerCase().includes("error")) {
    throw new Error(output.trim());
  }
}
