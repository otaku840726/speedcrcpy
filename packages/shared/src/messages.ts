/** JSON messages carried on Channel.JSON of a session WebSocket, both directions. */

export interface VideoMeta {
  codec: "h264" | "h265";
  width: number;
  height: number;
  presetId: string;
  /** Browser codec string for VideoDecoder, e.g. "avc1.64002a" (may be refined client-side) */
  codecString?: string;
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
  | { type: "setQuality"; presetId: string }
  | { type: "clipboardSet"; content: string; paste: boolean }
  | { type: "requestKeyframe" }
  | { type: "takeControl" }
  /** Keep the controlled device's physical screen off (lower heat/battery). */
  | { type: "setScreenOff"; off: boolean }
  /** Viewer capability: don't auto-step above this preset (e.g. software decoders). */
  | { type: "viewerCaps"; maxPresetId: string }
  /** Echo of a server `ping`, plus client receive time for delay-gradient estimation */
  | { type: "pong"; pingId: number; serverSentAt: number; clientReceivedAt: number }
  | { type: "decoderError"; detail: string };

// ---- server -> client ----

export type ServerMessage =
  | { type: "hello"; serial: string; deviceName: string; presetId: string; controlling: boolean; screenOff: boolean }
  | { type: "screenOffChanged"; off: boolean }
  | { type: "clipboard"; content: string }
  | { type: "qualityChanged"; presetId: string; auto: boolean }
  | {
      type: "stats";
      encodeBitrate: number;
      sendBitrate: number;
      droppedFrames: number;
      mode: "through" | "gate";
      presetId: string;
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

export type EventsMessage = { type: "devices"; devices: DeviceInfo[] };
