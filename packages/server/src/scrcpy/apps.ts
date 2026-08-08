import type { Adb } from "@yume-chan/adb";

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
