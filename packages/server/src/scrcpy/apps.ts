import type { DeviceAppInfo, DeviceAppsResponse, InstallApkResult } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import { getCachedAppLabel, hasCachedAppIcon, resolveAppsMetadataBatch } from "./app-metadata.js";
import { writeDeviceFile } from "./file-manager.js";

const decoder = new TextDecoder();

async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout } = await shell.spawnWait(command);
  return decoder.decode(stdout);
}

/**
 * Packages installed by the user, plus whichever is on screen.
 *
 * Third-party only (`-3`): the couple of hundred system packages a phone
 * carries would bury the one app a script is about, and no script here wants to
 * restart the dialer. The foreground one is the important half — it turns
 * "which of these strings is my game" into opening the game and pressing a
 * button.
 */
export async function listApps(adb: Adb): Promise<{ packages: string[]; foreground?: string }> {
  const listed = await sh(adb, "pm list packages -3");
  const packages = listed
    .split("\n")
    .map((line) => line.trim().replace(/^package:/, ""))
    .filter(Boolean)
    .sort();
  return { packages, foreground: await foregroundApp(adb) };
}

/**
 * Detailed app list supporting user, system, or all apps with versions and foreground status.
 */
export async function listDetailedApps(
  adb: Adb,
  filter: "user" | "system" | "all" = "user",
): Promise<DeviceAppsResponse> {
  let flag = "-3 -f";
  if (filter === "system") flag = "-s -f";
  if (filter === "all") flag = "-f";

  const [listed, versionDump, fg] = await Promise.all([
    sh(adb, `pm list packages ${flag}`),
    sh(adb, "dumpsys package packages | grep -E 'Package \\[|versionName='").catch(() => ""),
    foregroundApp(adb).catch(() => undefined),
  ]);

  // Parse versions map: Package [com.example] -> versionName=1.0.0
  const versionMap = new Map<string, string>();
  let currentPkg: string | undefined;
  for (const line of versionDump.split("\n")) {
    const pkgMatch = line.match(/Package \[([^\]]+)\]/);
    if (pkgMatch) {
      currentPkg = pkgMatch[1];
      continue;
    }
    if (currentPkg) {
      const verMatch = line.match(/versionName=([^\s]+)/);
      if (verMatch?.[1]) {
        versionMap.set(currentPkg, verMatch[1]);
        currentPkg = undefined;
      }
    }
  }

  // Parse `package:/path/to/apk=com.example.app`
  const apps: DeviceAppInfo[] = [];
  for (const line of listed.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("package:")) continue;
    const content = trimmed.slice(8);
    const lastEq = content.lastIndexOf("=");
    if (lastEq === -1) continue;

    const apkPath = content.slice(0, lastEq);
    const packageName = content.slice(lastEq + 1);
    if (!packageName) continue;

    const isSystem = apkPath.startsWith("/system/") || apkPath.startsWith("/product/") || apkPath.startsWith("/vendor/");

    apps.push({
      packageName,
      apkPath,
      versionName: versionMap.get(packageName),
      isSystem,
      isForeground: fg === packageName,
    });
  }

  if (filter === "user") {
    // Warm up labels & icons for user apps (concurrency 4, cached permanently)
    await resolveAppsMetadataBatch(adb, apps).catch(() => {});
  }

  for (const app of apps) {
    app.name = getCachedAppLabel(app.packageName);
    app.hasIcon = hasCachedAppIcon(app.packageName);
  }

  apps.sort((a, b) => (a.name || a.packageName).localeCompare(b.name || b.packageName));
  return { apps, foreground: fg };
}

/**
 * The package currently on screen.
 *
 * Two commands because neither works everywhere: `mCurrentFocus` is missing
 * while a window is animating in, and `topResumedActivity` does not exist
 * before Android 10. Whichever answers first is the answer.
 */
export async function foregroundApp(adb: Adb): Promise<string | undefined> {
  const out = await sh(
    adb,
    "dumpsys window | grep -m1 mCurrentFocus=; dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'",
  ).catch(() => "");
  // Both print the component as `package/activity`, somewhere in a longer line.
  const match = out.match(/\s([a-zA-Z][\w.]*\.[\w.]+)\/[\w./]+/);
  return match?.[1];
}

/** `am start` needs a component, and a package alone does not name one. monkey
 * resolves the launcher activity itself, which is the same thing tapping the
 * icon does. */
const LAUNCH = (pkg: string) => `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;

export const stopApp = (adb: Adb, pkg: string): Promise<string> => sh(adb, `am force-stop ${pkg}`);
export const startApp = (adb: Adb, pkg: string): Promise<string> => sh(adb, LAUNCH(pkg));

/** A package name as Android accepts it. Checked before it reaches a shell
 * line, which is the only reason this is not just a string. */
export const isPackageName = (value: string): boolean => /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(value);

export async function uninstallApp(adb: Adb, pkg: string): Promise<string> {
  if (!isPackageName(pkg)) throw new Error("無效的套件名稱");
  return await sh(adb, `pm uninstall ${pkg}`);
}

export async function clearAppData(adb: Adb, pkg: string): Promise<string> {
  if (!isPackageName(pkg)) throw new Error("無效的套件名稱");
  return await sh(adb, `pm clear ${pkg}`);
}

export async function getApkPath(adb: Adb, pkg: string): Promise<string | undefined> {
  if (!isPackageName(pkg)) throw new Error("無效的套件名稱");
  const out = await sh(adb, `pm path ${pkg}`);
  const match = out.match(/package:([^\s]+)/);
  return match?.[1];
}

export async function installApkStream(adb: Adb, stream: ReadableStream<Uint8Array>): Promise<InstallApkResult> {
  const tempPath = `/data/local/tmp/app_install_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.apk`;
  try {
    await writeDeviceFile(adb, tempPath, stream);
    const output = await sh(adb, `pm install -r -d "${tempPath}"`);
    const isSuccess = output.includes("Success");
    if (!isSuccess) {
      return {
        ok: false,
        output: output.trim(),
        error: output.trim() || "安裝失敗",
      };
    }
    return {
      ok: true,
      output: output.trim(),
    };
  } finally {
    await sh(adb, `rm -f "${tempPath}"`).catch(() => {});
  }
}
