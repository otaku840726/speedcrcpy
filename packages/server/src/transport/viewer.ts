import {
  Channel,
  chunkVideoFrame,
  decodeFrame,
  encodeAudioDataFrame,
  encodeJsonFrame,
  encodeMetaFrame,
  encodeVideoConfFrame,
  type AudioMeta,
  type ClientMessage,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidMotionEventAction,
  ScrcpyPointerId,
  type AndroidKeyEventMeta,
  type ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import type { WebSocket } from "ws";
import type { ManagedSession, SessionViewer } from "../scrcpy/session-manager.js";
import { ViewerCongestion } from "./congestion.js";
import { SendQueue } from "./send-queue.js";

const NAVIGATE_KEYCODES: Record<string, AndroidKeyCode> = {
  home: AndroidKeyCode.AndroidHome,
  appSwitch: AndroidKeyCode.AndroidAppSwitch,
  power: AndroidKeyCode.Power,
  volumeUp: AndroidKeyCode.VolumeUp,
  volumeDown: AndroidKeyCode.VolumeDown,
};

const TOUCH_ACTIONS = {
  down: AndroidMotionEventAction.Down,
  move: AndroidMotionEventAction.Move,
  up: AndroidMotionEventAction.Up,
  cancel: AndroidMotionEventAction.Cancel,
} as const;

/**
 * One connected client of a device session: owns the send queue, forwards
 * media packets, and routes incoming control messages.
 */
export class Viewer implements SessionViewer {
  private readonly queue: SendQueue;
  private readonly congestion: ViewerCongestion;
  private readonly unsubscribes: (() => void)[] = [];
  private frameId = 0;
  private sentAudioMeta = false;
  private videoGated = false;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly session: ManagedSession,
  ) {
    this.queue = new SendQueue(ws);
    this.congestion = new ViewerCongestion(this.queue, {
      sendPing: (pingId, sentAt) => this.sendJson({ type: "ping", pingId, sentAt }),
      setGate: (gated) => {
        this.videoGated = gated;
      },
      requestKeyframe: () => void this.session.requestResetVideo(),
      emitStats: (stats) =>
        this.sendJson({
          type: "stats",
          encodeBitrate: this.session.quality.videoBitRate,
          sendBitrate: Math.round(stats.sendBitrate),
          droppedFrames: this.queue.droppedFrames,
          mode: stats.mode,
          quality: this.session.quality,
          rttMs: Math.round(stats.rttMs),
          delayGradientMs: Math.round(stats.delayGradientMs),
          congestion: stats.congestion,
        }),
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.channel === Channel.JSON) this.handleMessage(frame.message as ClientMessage);
      } catch (error) {
        console.warn(`[viewer] bad frame from client: ${(error as Error).message}`);
      }
    });
    ws.on("close", () => this.detach());
    ws.on("error", () => this.detach());
  }

  attach(): void {
    this.session.attach(this);
    this.unsubscribes.push(this.session.congestion.register(this.congestion));

    this.sendJson({
      type: "hello",
      serial: this.session.serial,
      deviceName: this.session.deviceName,
      auto: this.session.autoAdapt,
      quality: this.session.quality,
      controlling: this.session.isControlling(this),
      screenOff: this.session.screenOff,
    });
    this.sendVideoStart();

    this.unsubscribes.push(
      this.session.onVideoPacket((packet) => this.onVideoPacket(packet)),
      this.session.onVideoSizeChanged(() => this.sendVideoMeta()),
      this.session.device.onAudioPacket((packet) => this.onAudioPacket(packet)),
      this.session.device.onClipboard((content) => this.sendJson({ type: "clipboard", content })),
    );

    // Late join: current config lets decode-through start immediately (heals
    // via intra-refresh); the debounced reset delivers a clean keyframe fast.
    void this.session.requestResetVideo();
  }

  notifyDeviceGone(): void {
    this.sendJson({ type: "deviceGone" });
    this.ws.close();
  }

  notifyControlChanged(controlling: boolean): void {
    this.sendJson({ type: "controlChanged", controlling });
  }

  notifyScreenOffChanged(off: boolean): void {
    this.sendJson({ type: "screenOffChanged", off });
  }

  /** Quality switch completed: restart the client decoder on the new stream. */
  notifyVideoRestarted(byAuto: boolean): void {
    this.queue.clearVideo();
    this.sendJson({
      type: "qualityChanged",
      auto: this.session.autoAdapt,
      quality: this.session.quality,
      byAuto,
    });
    this.sendVideoMeta();
    // The buffered config + keyframe of the new stream follow through the
    // regular onVideoPacket path right after this call.
  }

  /** Auto/manual toggled with no stream restart — just sync the client's UI. */
  notifyQualityMode(): void {
    this.sendJson({
      type: "qualityChanged",
      auto: this.session.autoAdapt,
      quality: this.session.quality,
      byAuto: false,
    });
  }

  private detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.congestion.dispose();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.queue.close();
    this.session.detach(this);
  }

  /** VIDEO_META (+ current config) — sent on attach and whenever size changes. */
  private sendVideoStart(): void {
    this.sendVideoMeta();
    const config = this.session.video.currentConfig;
    if (config) this.queue.enqueueControl(encodeVideoConfFrame(config));
  }

  private sendVideoMeta(): void {
    const video = this.session.video;
    const meta: VideoMeta = {
      codec: video.codec,
      width: video.width,
      height: video.height,
      quality: this.session.quality,
    };
    this.queue.enqueueControl(encodeMetaFrame(Channel.VIDEO_META, meta));
  }

  private onVideoPacket(packet: ScrcpyMediaStreamPacket): void {
    if (packet.type === "configuration") {
      this.queue.enqueueControl(encodeVideoConfFrame(packet.data));
      return;
    }
    if (this.videoGated) return;
    const chunks = chunkVideoFrame(this.frameId++, packet.keyframe ?? false, packet.pts ?? 0n, packet.data);
    this.queue.enqueueVideoFrame(chunks);
  }

  private onAudioPacket(packet: ScrcpyMediaStreamPacket): void {
    if (packet.type === "configuration") return;
    if (!this.sentAudioMeta) {
      const meta: AudioMeta | undefined = this.session.device.audioMeta;
      if (!meta) return;
      this.queue.enqueueControl(encodeMetaFrame(Channel.AUDIO_META, meta));
      this.sentAudioMeta = true;
    }
    this.queue.enqueueAudio(encodeAudioDataFrame(packet.pts ?? 0n, packet.data));
  }

  private sendJson(message: ServerMessage): void {
    this.queue.enqueueControl(encodeJsonFrame(message));
  }

  private handleMessage(message: ClientMessage): void {
    const controller = this.session.device.controller;

    switch (message.type) {
      case "takeControl":
        this.session.takeControl(this);
        return;
      case "viewerCaps":
        // Any viewer may lower the shared encode (worst-viewer-wins policy).
        this.session.setViewerCap(this, message.maxLadderIndex);
        return;
      case "pong":
        this.congestion.handlePong(message.pingId, message.serverSentAt, message.clientReceivedAt);
        return;
      case "decoderError":
        console.warn(`[viewer] client decoder error: ${message.detail}`);
        this.congestion.onDecoderError();
        void this.session.requestResetVideo();
        return;
      case "requestKeyframe":
        void this.session.requestResetVideo();
        return;
    }

    // Everything below injects input or changes shared session state —
    // restricted to the controlling viewer.
    if (!this.session.isControlling(this)) return;

    if (message.type === "setScreenOff") {
      this.session.setScreenOff(message.off);
      return;
    }

    // Coordinates are normalized against the frame the CLIENT displays; use
    // the client-reported dims so scrcpy's size check can drop events from a
    // stale stream generation (rotation / quality switch / display resize)
    // instead of mis-mapping them onto the new one.
    if ((message.type === "touch" || message.type === "scroll") && (message.vw <= 0 || message.vh <= 0)) {
      return;
    }

    // Position-dependent input goes through the VIDEO instance's controller —
    // its capture size is the frame the viewer sees. The persistent control
    // instance (video:false) maps coordinates against the native display size
    // and would misplace them whenever the video is scaled down.
    const videoController = this.session.video.controller;

    switch (message.type) {
      case "touch":
        void videoController
          ?.injectTouch({
            action: TOUCH_ACTIONS[message.action],
            pointerId: message.pointerId < 0 ? ScrcpyPointerId.Mouse : BigInt(message.pointerId),
            pointerX: Math.min(Math.round(message.x * message.vw), message.vw - 1),
            pointerY: Math.min(Math.round(message.y * message.vh), message.vh - 1),
            videoWidth: message.vw,
            videoHeight: message.vh,
            pressure: message.pressure,
            actionButton: 0,
            buttons: 0,
          })
          .catch(() => {});
        break;
      case "scroll":
        void videoController
          ?.injectScroll({
            pointerX: Math.min(Math.round(message.x * message.vw), message.vw - 1),
            pointerY: Math.min(Math.round(message.y * message.vh), message.vh - 1),
            videoWidth: message.vw,
            videoHeight: message.vh,
            scrollX: message.dx,
            scrollY: message.dy,
            buttons: 0,
          })
          .catch(() => {});
        break;
      case "key":
        void controller
          .injectKeyCode({
            action: message.action === "down" ? AndroidKeyEventAction.Down : AndroidKeyEventAction.Up,
            keyCode: message.keycode as AndroidKeyCode,
            metaState: message.metaState as AndroidKeyEventMeta,
            repeat: message.repeat,
          })
          .catch(() => {});
        break;
      case "text":
        void controller.injectText(message.text).catch(() => {});
        break;
      case "navigate":
        if (message.key === "back") {
          void controller.backOrScreenOn(AndroidKeyEventAction.Down).catch(() => {});
          void controller.backOrScreenOn(AndroidKeyEventAction.Up).catch(() => {});
        } else {
          const keyCode = NAVIGATE_KEYCODES[message.key];
          if (keyCode !== undefined) void this.pressKey(keyCode);
        }
        break;
      case "rotate":
        void controller.rotateDevice().catch(() => {});
        break;
      case "clipboardSet":
        void this.session.device.setClipboard(message.content, message.paste).catch(() => {});
        break;
      case "setQuality":
        void this.session.setQualityMode(message.auto, message.quality);
        break;
      default:
        // Ignore unknown types so old clients stay compatible.
        break;
    }
  }

  private async pressKey(keyCode: AndroidKeyCode): Promise<void> {
    const controller = this.session.device.controller;
    const metaState = 0 as AndroidKeyEventMeta;
    try {
      await controller.injectKeyCode({ action: AndroidKeyEventAction.Down, keyCode, metaState, repeat: 0 });
      await controller.injectKeyCode({ action: AndroidKeyEventAction.Up, keyCode, metaState, repeat: 0 });
    } catch {
      // Session is tearing down.
    }
  }
}
