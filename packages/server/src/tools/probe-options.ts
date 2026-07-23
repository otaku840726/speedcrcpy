/**
 * Bisect which videoCodecOptions crash the device encoder.
 *   pnpm exec tsx src/tools/probe-options.ts <serial>
 */
import { DEFAULT_PRESET_ID, presetById } from "@speedcrcpy/shared";
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { ScrcpyInstanceId } from "@yume-chan/scrcpy";
import { setTimeout as delay } from "node:timers/promises";
import { AdbManager } from "../adb/adb-manager.js";
import { loadConfig } from "../config.js";
import { pushServer, SCRCPY_SERVER_VERSION } from "../scrcpy/server-binary.js";

const serial = process.argv[2];
if (!serial) {
  console.error("usage: tsx src/tools/probe-options.ts <serial>");
  process.exit(1);
}

const config = loadConfig();
const adbManager = new AdbManager(config);
await adbManager.start();
const adb = await adbManager.createAdb(serial);

const preset = presetById(DEFAULT_PRESET_ID)!;

const variants: [string, string | undefined][] = [
  ["no codec options", undefined],
  ["bitrate-mode only", "bitrate-mode=2"],
  ["i-frame-interval only", "i-frame-interval=10"],
  ["max-bframes only", "max-bframes=0"],
  ["repeat-previous-frame only", "repeat-previous-frame-after-us=33333"],
  ["intra-refresh only", "intra-refresh-period=120"],
];

for (const [label, codecOptions] of variants) {
  const options = new AdbScrcpyOptionsLatest(
    {
      scid: ScrcpyInstanceId.random(),
      video: true,
      audio: false,
      control: false,
      maxSize: preset.maxSize,
      videoBitRate: preset.videoBitRate,
      maxFps: preset.maxFps,
      videoCodec: "h264",
      videoCodecOptions: codecOptions,
      clipboardAutosync: false,
    },
    { version: SCRCPY_SERVER_VERSION },
  );

  process.stdout.write(`${label.padEnd(30)} ... `);
  try {
    const serverPath = await pushServer(adb);
    const client = await AdbScrcpyClient.start(adb, serverPath, options);
    const video = await client.videoStream;
    let packets = 0;
    const reader = video.stream.getReader();
    const readLoop = (async () => {
      while (packets < 10) {
        const { done } = await reader.read();
        if (done) break;
        packets++;
      }
    })();
    await Promise.race([readLoop, delay(4000)]);
    console.log(packets >= 10 ? `OK (${video.width}x${video.height})` : `STARTED but only ${packets} packets`);
    await client.close();
  } catch (error) {
    console.log(`FAILED: ${(error as Error).message}`);
  }
  await delay(500);
}

await adbManager.stop();
process.exit(0);
