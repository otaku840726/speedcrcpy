import type { AudioMeta } from "@speedcrcpy/shared";

/**
 * AudioWorklet jitter buffer: flat ring of decoded stereo samples.
 * - Starts playing only after PREBUFFER samples are queued (absorbs jitter).
 * - When latency exceeds MAX, skips ahead ONCE to TARGET (a single, rare
 *   discontinuity instead of continuous chunk dropping — repeated 20 ms drops
 *   are audible as constant crackling), then ramps gain back in over ~5 ms to
 *   mask the seam. Underrun resume gets the same ramp-in.
 * Runs on the audio thread; communicates via port messages.
 */
const WORKLET_SOURCE = `
class JitterBuffer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 48000;                 // 1 s ring
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.playing = false;
    this.prebuffer = 48000 * 0.08;         // 80 ms
    this.maxLatency = 48000 * 0.25;        // 250 ms hard cap
    this.target = 48000 * 0.12;            // skip back to 120 ms on overflow
    this.fadeTotal = 256;                  // ~5 ms ramp after a discontinuity
    this.fadeLeft = 0;
    this.port.onmessage = (event) => this.write(event.data.left, event.data.right);
  }

  write(l, r) {
    const len = l.length;
    if (this.available + len > this.maxLatency) {
      const drop = Math.min(this.available + len - this.target, this.available);
      this.readPos = (this.readPos + drop) % this.capacity;
      this.available -= drop;
      this.fadeLeft = this.fadeTotal;
    }
    for (let i = 0; i < len; i++) {
      this.left[this.writePos] = l[i];
      this.right[this.writePos] = r[i];
      this.writePos = (this.writePos + 1) % this.capacity;
    }
    this.available += len;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] ?? out[0];
    const frames = l.length;

    if (!this.playing) {
      if (this.available < this.prebuffer) return true;
      this.playing = true;
      this.fadeLeft = this.fadeTotal;
    }
    if (this.available < frames) {
      // Underrun: silence this block and rebuild the prebuffer.
      this.playing = false;
      return true;
    }

    for (let i = 0; i < frames; i++) {
      let gain = 1;
      if (this.fadeLeft > 0) {
        gain = 1 - this.fadeLeft / this.fadeTotal;
        this.fadeLeft--;
      }
      l[i] = this.left[this.readPos] * gain;
      r[i] = this.right[this.readPos] * gain;
      this.readPos = (this.readPos + 1) % this.capacity;
    }
    this.available -= frames;
    return true;
  }
}
registerProcessor("jitter-buffer", JitterBuffer);
`;

export type AudioState = "unavailable" | "locked" | "playing";

type WasmOpusDecoder = {
  ready: Promise<void>;
  free: () => void;
  decodeFrame: (frame: Uint8Array) => { channelData: Float32Array[]; samplesDecoded: number };
};

const FORCE_FALLBACK = new URLSearchParams(location.search).has("sw");

/**
 * Opus playback with two paths:
 * - Secure contexts: WebCodecs AudioDecoder → AudioWorklet jitter buffer.
 * - Insecure contexts (plain-HTTP LAN) where AudioDecoder/AudioWorklet are
 *   unavailable: WASM libopus decode → scheduled AudioBufferSourceNodes.
 * "unavailable" is only reported when not even an AudioContext exists.
 */
export class AudioPipeline {
  onStateChange: ((state: AudioState) => void) | undefined;

  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private decoder: AudioDecoder | undefined;
  private wasmDecoder: WasmOpusDecoder | undefined;
  private wasmReady = false;
  private nextPlayTime = 0;
  private meta: AudioMeta | undefined;
  private starting = false;
  private disposed = false;

  private static get hasNativePath(): boolean {
    return (
      typeof AudioDecoder !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof AudioContext !== "undefined" &&
      "audioWorklet" in AudioContext.prototype
    );
  }

  static get isSupported(): boolean {
    return typeof AudioContext !== "undefined";
  }

  private get useNative(): boolean {
    return AudioPipeline.hasNativePath && !FORCE_FALLBACK;
  }

  get state(): AudioState {
    if (!AudioPipeline.isSupported) return "unavailable";
    if (!this.context || this.context.state !== "running") return "locked";
    return "playing";
  }

  async start(meta: AudioMeta): Promise<void> {
    if (!AudioPipeline.isSupported || this.starting || this.context) return;
    this.starting = true;
    this.meta = meta;

    const context = new AudioContext({ sampleRate: meta.sampleRate, latencyHint: "interactive" });
    this.context = context;

    if (this.useNative) {
      const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const node = new AudioWorkletNode(context, "jitter-buffer", {
        outputChannelCount: [meta.channels],
      });
      node.connect(context.destination);
      this.node = node;
      this.createDecoder(meta);
    } else {
      // Lazy-load the WASM decoder only when actually needed (~100 KB).
      const { OpusDecoder } = await import("opus-decoder");
      const decoder = new OpusDecoder({ channels: meta.channels, forceStereo: true }) as unknown as WasmOpusDecoder;
      await decoder.ready;
      if (this.disposed) {
        decoder.free();
        return;
      }
      this.wasmDecoder = decoder;
      this.wasmReady = true;
    }

    this.starting = false;
    this.notify();
    context.onstatechange = () => this.notify();
  }

  push(pts: bigint, data: Uint8Array): void {
    if (this.useNative) {
      const decoder = this.decoder;
      if (!decoder || decoder.state !== "configured") return;
      // Never drop encoded packets in normal operation — Opus predicts across
      // frames, so a missing packet corrupts the decode (audible crackle).
      // Excess latency is handled losslessly by the worklet's skip-ahead.
      // The guard only protects against runaway queues in throttled tabs.
      if (decoder.decodeQueueSize > 64) return;
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: Number(pts),
          data: data as BufferSource,
        }),
      );
      return;
    }

    if (!this.wasmReady || !this.wasmDecoder || !this.context) return;
    try {
      const { channelData, samplesDecoded } = this.wasmDecoder.decodeFrame(data);
      if (samplesDecoded > 0) this.scheduleBuffer(channelData, samplesDecoded);
    } catch {
      // A corrupt packet is not fatal; the next one resynchronizes.
    }
  }

  /** Must be called from a user gesture (autoplay policy). */
  async unlock(): Promise<void> {
    if (!this.context) return;
    await this.context.resume().catch(() => {});
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.decoder?.close();
    this.decoder = undefined;
    this.wasmDecoder?.free();
    this.wasmDecoder = undefined;
    this.node?.disconnect();
    this.node = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
  }

  /**
   * Fallback playout: schedule each decoded frame as an AudioBufferSourceNode
   * on a rolling cursor ~60 ms ahead of the clock; skip ahead when the
   * backlog exceeds 350 ms so latency stays bounded.
   */
  private scheduleBuffer(channelData: Float32Array[], samples: number): void {
    const context = this.context!;
    const meta = this.meta!;
    const buffer = context.createBuffer(meta.channels, samples, meta.sampleRate);
    buffer.getChannelData(0).set(channelData[0]!);
    if (meta.channels > 1) buffer.getChannelData(1).set(channelData[1] ?? channelData[0]!);

    const now = context.currentTime;
    if (this.nextPlayTime > now + 0.35) this.nextPlayTime = now + 0.12;
    if (this.nextPlayTime < now + 0.02) this.nextPlayTime = now + 0.06;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  private createDecoder(meta: AudioMeta): void {
    const decoder = new AudioDecoder({
      output: (audio) => this.handleDecoded(audio),
      error: (error) => {
        console.warn("[audio] decoder error:", error.message);
        // Recreate on the next packet.
        this.decoder?.close();
        this.decoder = undefined;
        if (this.meta) this.createDecoder(this.meta);
      },
    });
    decoder.configure({
      codec: "opus",
      sampleRate: meta.sampleRate,
      numberOfChannels: meta.channels,
    });
    this.decoder = decoder;
  }

  private handleDecoded(audio: AudioData): void {
    const node = this.node;
    if (!node) {
      audio.close();
      return;
    }
    const frames = audio.numberOfFrames;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    audio.copyTo(left, { planeIndex: 0, format: "f32-planar" });
    if (audio.numberOfChannels > 1) {
      audio.copyTo(right, { planeIndex: 1, format: "f32-planar" });
    } else {
      right.set(left);
    }
    audio.close();
    node.port.postMessage({ left, right }, [left.buffer, right.buffer]);
  }

  private notify(): void {
    this.onStateChange?.(this.state);
  }
}
