import type { QualityPreset } from "@speedcrcpy/shared";
import { AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { ScrcpyInstanceId } from "@yume-chan/scrcpy";
import { SCRCPY_SERVER_VERSION } from "./server-binary.js";

/**
 * Encoder tuning for weak networks:
 * - CBR (bitrate-mode=2): no bitrate bursts — bursts trigger path loss
 * - long GOP (10 s): recovery uses RESET_VIDEO / intra-refresh, not dense IDRs
 * - intra-refresh: spreads I-frame cost across frames so the picture heals
 *   progressively ("controlled mosaic") instead of stalling for a big keyframe
 * MediaFormat keys unsupported by an encoder are ignored by Android, so this
 * string is safe to send everywhere; actual support is probed at runtime.
 */
function videoCodecOptions(maxFps: number, intraRefresh: boolean): string {
  const options = [
    "bitrate-mode=2",
    `i-frame-interval=10`,
    "max-bframes=0",
    // Keep emitting frames on a static screen so throughput estimation works.
    `repeat-previous-frame-after-us=${Math.round(1_000_000 / Math.min(maxFps, 30))}`,
  ];
  if (intraRefresh) {
    // Refresh the whole picture over ~2 s worth of frames.
    options.push(`intra-refresh-period=${Math.max(2, Math.round(maxFps * 2))}`);
  }
  return options.join(",");
}

export interface VideoSessionConfig {
  preset: QualityPreset;
  codec: "h264" | "h265";
  intraRefresh: boolean;
}

export function makeVideoOptions(config: VideoSessionConfig) {
  return new AdbScrcpyOptionsLatest(
    {
      scid: ScrcpyInstanceId.random(),
      video: true,
      audio: false,
      control: true,
      maxSize: config.preset.maxSize,
      videoBitRate: config.preset.videoBitRate,
      maxFps: config.preset.maxFps,
      videoCodec: config.codec,
      videoCodecOptions: videoCodecOptions(config.preset.maxFps, config.intraRefresh),
      clipboardAutosync: false,
    },
    { version: SCRCPY_SERVER_VERSION },
  );
}

export function makeControlOptions() {
  return new AdbScrcpyOptionsLatest(
    {
      scid: ScrcpyInstanceId.random(),
      video: false,
      audio: true,
      audioCodec: "opus",
      control: true,
      clipboardAutosync: true,
      // With video off, the 64-byte device-name header would land on the
      // audio socket and be misparsed as the audio codec id — don't send it.
      sendDeviceMeta: false,
    },
    { version: SCRCPY_SERVER_VERSION },
  );
}
