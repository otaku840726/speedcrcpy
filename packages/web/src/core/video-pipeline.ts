import type { VideoMeta } from "@speedcrcpy/shared";
import { ScrcpyVideoCodecId } from "@yume-chan/scrcpy";
import { TinyH264Decoder } from "@yume-chan/scrcpy-decoder-tinyh264";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import type { VideoFrameData } from "./session-client";

type AnyDecoder = WebCodecsVideoDecoder | TinyH264Decoder;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Browser decoder lifecycle across stream (re)starts. The canvas element is
 * created once and survives decoder swaps (quality switches) so the picture
 * never flickers or detaches from the DOM.
 */
export class VideoPipeline {
  readonly element: HTMLCanvasElement;
  onSizeChanged: ((width: number, height: number) => void) | undefined;
  onDecoderError: ((detail: string) => void) | undefined;
  framesRendered = 0;

  private renderer: WebGLVideoFrameRenderer | BitmapVideoFrameRenderer | undefined;
  private decoder: AnyDecoder | undefined;
  private writer: WritableStreamDefaultWriter<unknown> | undefined;
  private currentConfig: Uint8Array | undefined;
  private configWritten = false;
  private lastMeta: VideoMeta | undefined;
  /** Feed nothing until a keyframe: strict decoders (TinyH264) permanently
   * error their stream on delta-before-keyframe, turning late-join black. */
  private awaitingKeyframe = true;
  private lastRebuildAt = 0;
  // `?sw` forces the software decoder — for testing the insecure-context path.
  private readonly useWebCodecs =
    WebCodecsVideoDecoder.isSupported && !new URLSearchParams(location.search).has("sw");

  /** Software decode is CPU-bound — viewers should cap the quality ladder. */
  get isSoftware(): boolean {
    return !this.useWebCodecs;
  }

  constructor() {
    this.element = document.createElement("canvas");
    if (this.useWebCodecs) {
      this.renderer = WebGLVideoFrameRenderer.isSupported
        ? new WebGLVideoFrameRenderer(this.element)
        : new BitmapVideoFrameRenderer(this.element);
    }
  }

  /** A new VIDEO_META begins a fresh stream: swap the decoder, keep the canvas. */
  start(meta: VideoMeta): void {
    this.lastMeta = meta;
    this.disposeDecoder();
    this.configWritten = false;
    this.awaitingKeyframe = true;

    if (this.useWebCodecs) {
      const codec = meta.codec === "h265" ? ScrcpyVideoCodecId.H265 : ScrcpyVideoCodecId.H264;
      const decoder = new WebCodecsVideoDecoder({ codec, renderer: this.renderer! });
      decoder.sizeChanged(({ width, height }) => this.onSizeChanged?.(width, height));
      this.decoder = decoder;
    } else {
      const decoder = new TinyH264Decoder({ canvas: this.element });
      decoder.sizeChanged(({ width, height }) => this.onSizeChanged?.(width, height));
      this.decoder = decoder;
    }

    this.writer = this.decoder.writable.getWriter() as WritableStreamDefaultWriter<unknown>;
    // Config can arrive before META on late-join races; replay it.
    if (this.currentConfig) this.writeConfig(this.currentConfig);
  }

  setConfig(config: Uint8Array): void {
    // Every server-side RESET_VIDEO (viewer joins, congestion recovery,
    // decoder-error reports from ANY viewer) rebroadcasts the SPS/PPS.
    // Reconfiguring the decoder tears the picture for a frame — skip when
    // the parameters haven't actually changed.
    if (this.configWritten && this.currentConfig && bytesEqual(this.currentConfig, config)) {
      return;
    }
    this.currentConfig = config;
    if (this.decoder) this.writeConfig(config);
  }

  pushFrame(frame: VideoFrameData): void {
    if (!this.writer || !this.configWritten) return;
    if (this.awaitingKeyframe) {
      if (!frame.keyframe) return;
      this.awaitingKeyframe = false;
    }
    this.framesRendered++;
    void this.writer
      .write({ type: "data", keyframe: frame.keyframe, pts: frame.pts, data: frame.data })
      .catch((error: unknown) => this.handleError(error));
  }

  dispose(): void {
    this.disposeDecoder();
  }

  private writeConfig(config: Uint8Array): void {
    this.configWritten = true;
    void this.writer?.write({ type: "configuration", data: config }).catch((error: unknown) => this.handleError(error));
  }

  private handleError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    // A decode error may leave the writable stream permanently errored —
    // rebuild the decoder (same canvas) and wait for the next keyframe.
    // onDecoderError asks the server for one (resetVideo). Throttled so a
    // hard failure can't spin.
    const now = Date.now();
    if (this.lastMeta && now - this.lastRebuildAt > 1_000) {
      this.lastRebuildAt = now;
      this.start(this.lastMeta);
    }
    this.onDecoderError?.(detail);
  }

  private disposeDecoder(): void {
    this.writer?.releaseLock();
    this.writer = undefined;
    this.decoder?.dispose();
    this.decoder = undefined;
  }
}
