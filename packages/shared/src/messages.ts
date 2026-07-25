/** JSON messages carried on Channel.JSON of a session WebSocket, both directions. */

import type { QualitySettings } from "./presets.js";

export interface VideoMeta {
  codec: "h264" | "h265";
  width: number;
  height: number;
  /** Encoder settings of this stream generation; a change means a new encoder
   * instance (new SPS/PPS) — the client restarts its decoder on it. */
  quality: QualitySettings;
}

export interface AudioMeta {
  codec: "opus";
  sampleRate: number;
  channels: number;
}

// ---- client -> server ----

export type ClientMessage =
  /**
   * Pointer coordinates are normalized (0..1) against the video frame the
   * CLIENT is currently displaying; vw/vh are that frame's pixel dimensions.
   * The server forwards vw/vh to scrcpy, whose size check then drops events
   * generated against a stale stream (rotation / quality switch / display
   * resize races) instead of mis-mapping them.
   */
  | { type: "touch"; action: "down" | "move" | "up" | "cancel"; pointerId: number; x: number; y: number; pressure: number; vw: number; vh: number }
  | { type: "scroll"; x: number; y: number; dx: number; dy: number; vw: number; vh: number }
  | { type: "key"; action: "down" | "up"; keycode: number; metaState: number; repeat: number }
  | { type: "text"; text: string }
  | { type: "navigate"; key: "back" | "home" | "appSwitch" | "power" | "volumeUp" | "volumeDown" }
  | { type: "rotate" }
  /**
   * Set quality. `auto` true resumes ladder-based adaptation; false pins the
   * exact settings (resolution / bitrate / fps chosen independently).
   */
  | { type: "setQuality"; auto: boolean; quality: QualitySettings }
  | { type: "clipboardSet"; content: string; paste: boolean }
  | { type: "requestKeyframe" }
  | { type: "takeControl" }
  /** Keep the controlled device's physical screen off (lower heat/battery). */
  | { type: "setScreenOff"; off: boolean }
  /** Viewer capability: cap auto-adaptation at this ladder index (software decoders). */
  | { type: "viewerCaps"; maxLadderIndex: number }
  /** Echo of a server `ping`, plus client receive time for delay-gradient estimation */
  | { type: "pong"; pingId: number; serverSentAt: number; clientReceivedAt: number }
  | { type: "decoderError"; detail: string };

// ---- server -> client ----

export type ServerMessage =
  | {
      type: "hello";
      serial: string;
      deviceName: string;
      auto: boolean;
      quality: QualitySettings;
      controlling: boolean;
      screenOff: boolean;
    }
  | { type: "screenOffChanged"; off: boolean }
  | { type: "clipboard"; content: string }
  /** `byAuto` true = the adaptation controller changed it (UI shouldn't flip the toggle). */
  | { type: "qualityChanged"; auto: boolean; quality: QualitySettings; byAuto: boolean }
  | {
      type: "stats";
      encodeBitrate: number;
      sendBitrate: number;
      droppedFrames: number;
      mode: "through" | "gate";
      quality: QualitySettings;
      rttMs: number;
      delayGradientMs: number;
      congestion: "ok" | "backpressure" | "stalled";
    }
  | { type: "ping"; pingId: number; sentAt: number }
  | { type: "controlChanged"; controlling: boolean }
  | { type: "deviceGone" }
  | { type: "error"; message: string };

// ---- device events websocket (/ws/events) ----

export interface DeviceInfo {
  serial: string;
  name: string;
  state: "device" | "offline" | "unauthorized" | "connecting" | "disconnected";
  address?: string;
  autoConnect: boolean;
}

/** Live device telemetry, refreshed server-side (~5 s). `null` = not readable. */
export interface DeviceStats {
  /** Battery charge, 0-100. */
  battery: number | null;
  /** Hottest CPU thermal zone, °C. */
  cpuTemp: number | null;
  /** CPU utilisation over the sample interval, 0-100 (null on the first sample). */
  cpuUsage: number | null;
  /** GPU utilisation, 0-100 (null on non-Qualcomm / unreadable GPUs). */
  gpuUsage: number | null;
  ramUsedKb: number | null;
  ramTotalKb: number | null;
}

export type EventsMessage = { type: "devices"; devices: DeviceInfo[] };
