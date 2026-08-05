/** JSON messages carried on Channel.JSON of a session WebSocket, both directions. */

import type { QualitySettings } from "./presets.js";

export type VideoCodec = "h264" | "h265";

export interface VideoMeta {
  codec: VideoCodec;
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
  /** Switch the device encoder codec live (make-before-break restart). */
  | { type: "setCodec"; codec: VideoCodec }
  | { type: "clipboardSet"; content: string; paste: boolean }
  | { type: "requestKeyframe" }
  | { type: "takeControl" }
  /** Give the seat up. Sent when you press 控制中 to step back, and on the way
   * out of a device you were driving. Nobody inherits it. */
  | { type: "releaseControl" }
  /**
   * Take control only if nobody holds it. Unlike `takeControl` this never
   * interrupts anyone — it is how returning to a device you were driving picks
   * the seat back up without pulling it off whoever took it meanwhile.
   */
  | { type: "claimControl" }
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
      codec: VideoCodec;
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
  /** Server evicted this viewer (admin kick) — stop reconnecting. */
  | { type: "kicked" }
  | { type: "error"; message: string };

// ---- connection admin (REST: GET /api/sessions) ----

/** One connected viewer of a device session. */
export interface ViewerConnection {
  id: string;
  transport: "websocket" | "webtransport";
  /** True for the viewer that currently holds input control. */
  controlling: boolean;
  /** Epoch ms when the viewer attached. */
  connectedAt: number;
  /** Remote address (X-Forwarded-For / socket), null when unknown. */
  address: string | null;
}

export interface SessionConnections {
  serial: string;
  deviceName: string;
  viewers: ViewerConnection[];
}

// ---- display override (REST: /api/devices/:serial/display) ----

/** Device native display size/density and any active `wm size`/`density` override. */
export interface DisplayInfo {
  nativeWidth: number;
  nativeHeight: number;
  nativeDensity: number;
  override: { width: number; height: number; density: number } | null;
}

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
