import { AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import type { Adb } from "@yume-chan/adb";
import type { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

export const SCRCPY_SERVER_VERSION = VERSION;

/**
 * Push scrcpy-server.jar under a UNIQUE path and return it.
 *
 * Each running server instance asynchronously unlinks its own jar shortly
 * after startup (CleanUp). With a shared filename, instance A's delayed
 * unlink races instance B's freshly pushed copy and B dies with
 * ClassNotFoundException — bitten in practice by our split-session design
 * and make-before-break switches. Unique per-start paths remove the race;
 * each instance deletes exactly its own file.
 */
export async function pushServer(adb: Adb): Promise<string> {
  const path = `/data/local/tmp/scrcpy-server-${randomBytes(4).toString("hex")}.jar`;
  const nodeStream = createReadStream(fileURLToPath(BIN));
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<MaybeConsumable<Uint8Array>>;
  await AdbScrcpyClient.pushServer(adb, webStream, path);
  return path;
}

/** Best-effort removal for jars whose instance failed to launch. */
export async function removeServer(adb: Adb, path: string): Promise<void> {
  await adb.subprocess.noneProtocol.spawnWait(["rm", "-f", path]).catch(() => {});
}
