/**
 * M2 verification tool: dump H.264 + audio stats from a connected device.
 *
 *   pnpm --filter @speedcrcpy/server exec tsx src/tools/dump.ts <serial> [seconds]
 *
 * Produces out.h264 (Annex B, playable with `ffplay out.h264`) and logs
 * packet/keyframe/audio statistics. Runs the control instance concurrently to
 * verify dual-scid operation on the device.
 */
import { DEFAULT_PRESET_ID, presetById } from "@speedcrcpy/shared";
import { createWriteStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { AdbManager } from "../adb/adb-manager.js";
import { loadConfig } from "../config.js";
import { DeviceSession } from "../scrcpy/device-session.js";
import { VideoPipeline } from "../scrcpy/video-pipeline.js";

const serial = process.argv[2];
const seconds = Number(process.argv[3] ?? "10");
if (!serial) {
  console.error("usage: tsx src/tools/dump.ts <serial> [seconds]");
  process.exit(1);
}

const config = loadConfig();
const adbManager = new AdbManager(config);
await adbManager.start();

const adb = await adbManager.createAdb(serial);

console.log("[dump] starting control+audio session...");
const session = await DeviceSession.start(adb);
let audioPackets = 0;
let audioBytes = 0;
session.onAudioPacket((packet) => {
  audioPackets++;
  audioBytes += packet.data.byteLength;
});
session.onClipboard((text) => console.log(`[dump] clipboard from device: ${JSON.stringify(text.slice(0, 80))}`));

console.log("[dump] starting video session...");
const preset = presetById(DEFAULT_PRESET_ID)!;
const video = await VideoPipeline.start(adb, { preset, codec: "h264", intraRefresh: true });
console.log(`[dump] video: ${video.codec} ${video.width}x${video.height}`);

const out = createWriteStream("out.h264");
let dataPackets = 0;
let keyframes = 0;
let videoBytes = 0;
let configs = 0;
video.onPacket((packet) => {
  if (packet.type === "configuration") {
    configs++;
    out.write(packet.data);
    return;
  }
  dataPackets++;
  videoBytes += packet.data.byteLength;
  if (packet.keyframe) keyframes++;
  out.write(packet.data);
});
video.onExit(() => console.log("[dump] video session exited"));
session.onExit(() => console.log("[dump] control session exited"));

await delay(seconds * 1000);

console.log(`[dump] video: ${configs} config, ${dataPackets} frames, ${keyframes} keyframes, ${(videoBytes / 1024).toFixed(0)} KiB in ${seconds}s (${((videoBytes * 8) / seconds / 1_000_000).toFixed(2)} Mbps)`);
console.log(`[dump] audio: meta=${JSON.stringify(session.audioMeta)}, ${audioPackets} packets, ${(audioBytes / 1024).toFixed(0)} KiB`);
console.log(`[dump] intra-refresh check: keyframes=${keyframes} — with intra-refresh working, expect 1 initial keyframe and no periodic IDR bursts`);

out.end();
await video.close();
await session.close();
await adbManager.stop();
console.log("[dump] done — verify with: ffplay out.h264");
process.exit(0);
