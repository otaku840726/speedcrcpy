import type { AudioMeta } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, type AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { AndroidScreenPowerMode, type ScrcpyControlMessageWriter, type ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { makeControlOptions } from "./options.js";
import { pushServer, removeServer } from "./server-binary.js";

// The device can wake itself (notifications, always-on display), so re-assert
// the off state on a slow timer rather than trusting a single command.
const SCREEN_OFF_REASSERT_MS = 3_000;

/**
 * The persistent scrcpy instance owning control (input), audio, and clipboard.
 * Runs `video: false` so quality switches never touch it.
 */
export class DeviceSession {
  audioMeta: AudioMeta | undefined;

  private readonly audioListeners = new Set<(packet: ScrcpyMediaStreamPacket) => void>();
  private readonly clipboardListeners = new Set<(text: string) => void>();
  private readonly exitListeners = new Set<() => void>();
  private closed = false;

  screenOff = false;
  private screenOffTimer: NodeJS.Timeout | undefined;
  private powerOffOnClose = false;

  private constructor(private readonly client: AdbScrcpyClient<AdbScrcpyOptionsLatest<false>>) {}

  get controller(): ScrcpyControlMessageWriter {
    const controller = this.client.controller;
    if (!controller) throw new Error("control disabled");
    return controller;
  }

  static async start(
    adb: Adb,
    options: { audio?: boolean; powerOffOnClose?: boolean } = {},
  ): Promise<DeviceSession> {
    const withAudio = options.audio ?? true;
    const powerOffOnClose = options.powerOffOnClose ?? false;
    // Unique jar per instance — see pushServer for the unlink race this avoids.
    const serverPath = await pushServer(adb);
    let client;
    try {
      client = await AdbScrcpyClient.start(adb, serverPath, makeControlOptions(withAudio, powerOffOnClose));
    } catch (error) {
      void removeServer(adb, serverPath);
      throw error;
    }
    const session = new DeviceSession(client);
    session.powerOffOnClose = powerOffOnClose;

    if (withAudio) {
      void session.consumeAudio();
      void session.consumeClipboard();
    }
    void session.consumeOutput();
    void client.exited.catch(() => {}).then(() => session.handleExit());

    return session;
  }

  onAudioPacket(listener: (packet: ScrcpyMediaStreamPacket) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onClipboard(listener: (text: string) => void): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async setClipboard(content: string, paste: boolean): Promise<void> {
    await this.controller.setClipboard({ content, paste, sequence: 0n });
  }

  /**
   * Keep the device's physical screen off while mirroring (lower heat/battery).
   * The encoder keeps capturing and input injection still works — this only
   * powers down the panel. Re-asserted on a timer since the device can wake
   * itself; restored to Normal when turned off or the session ends.
   */
  setScreenOff(off: boolean): void {
    this.screenOff = off;
    if (this.screenOffTimer) {
      clearInterval(this.screenOffTimer);
      this.screenOffTimer = undefined;
    }
    if (off) {
      void this.applyScreenPower(AndroidScreenPowerMode.Off);
      this.screenOffTimer = setInterval(() => {
        void this.applyScreenPower(AndroidScreenPowerMode.Off);
      }, SCREEN_OFF_REASSERT_MS);
    } else {
      void this.applyScreenPower(AndroidScreenPowerMode.Normal);
    }
  }

  private async applyScreenPower(mode: AndroidScreenPowerMode): Promise<void> {
    if (this.closed) return;
    await this.client.controller?.setScreenPowerMode(mode).catch(() => {});
  }

  /**
   * @param restore Power the panel back on when closing (default). Pass false
   * when another instance is about to take over screen-off (keeper → session
   * handover), so the panel doesn't flicker on.
   */
  async close(restore = true): Promise<void> {
    this.closed = true;
    if (this.screenOffTimer) clearInterval(this.screenOffTimer);
    // With powerOffOnClose, scrcpy's cleanup powers the screen off on close —
    // don't restore it (that's the point: stay off after disconnect).
    if (restore && this.screenOff && !this.powerOffOnClose) {
      await this.client.controller?.setScreenPowerMode(AndroidScreenPowerMode.Normal).catch(() => {});
    }
    await this.client.close();
  }

  private async consumeAudio(): Promise<void> {
    let metadata;
    try {
      metadata = await this.client.audioStream;
    } catch (error) {
      // Never let a metadata parse failure become an unhandled rejection —
      // the session stays usable without audio.
      console.warn(`[scrcpy:control] audio stream failed: ${(error as Error).message}`);
      return;
    }
    if (!metadata || metadata.type !== "success") {
      console.log(`[scrcpy:control] audio ${metadata?.type ?? "unavailable"} (needs Android 11+)`);
      return;
    }

    // scrcpy audio is always 48 kHz stereo.
    this.audioMeta = { codec: "opus", sampleRate: 48000, channels: 2 };

    const reader = metadata.stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const listener of this.audioListeners) listener(value);
      }
    } catch {
      // Stream broke — exit handling tears the session down.
    } finally {
      reader.releaseLock();
    }
  }

  private async consumeClipboard(): Promise<void> {
    const stream = this.client.clipboard;
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const listener of this.clipboardListeners) listener(value);
      }
    } catch {
      // Closed with the session.
    }
  }

  private async consumeOutput(): Promise<void> {
    const reader = this.client.output.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.trim()) console.log(`[scrcpy:control] ${value.trim()}`);
      }
    } catch {
      // Closed with the session.
    }
  }

  private handleExit(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.exitListeners) listener();
  }
}
