import type { AudioMeta } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import { AdbScrcpyClient, type AdbScrcpyOptionsLatest } from "@yume-chan/adb-scrcpy";
import { AndroidScreenPowerMode, type ScrcpyControlMessageWriter, type ScrcpyMediaStreamPacket } from "@yume-chan/scrcpy";
import { makeControlOptions } from "./options.js";
import { pushServer, removeServer } from "./server-binary.js";

/** One-shot shell command, trimmed. scrcpy's control channel has no message for
 * asking about power state, so this goes the plain adb way. */
async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout } = await shell.spawnWait(command);
  return new TextDecoder().decode(stdout);
}

/**
 * The device can wake itself (notifications, always-on display), so the off
 * state is re-asserted rather than trusted to a single command — quickly at
 * first, then rarely.
 *
 * Asking the device whether the panel is already off, and skipping the command
 * when it is, would cost more than it saves: the command is a few bytes on a
 * socket that is already open, while reading the state means a shell process
 * and a full `dumpsys`. Cadence is the lever, not a condition. The tail-off
 * trades a panel that could stay lit for up to half a minute after something
 * turned it on — for a device that is dark precisely because nobody is looking
 * at it.
 */
const SCREEN_OFF_FAST_MS = 3_000;
const SCREEN_OFF_SLOW_MS = 30_000;
/** How long the fast cadence lasts after turning the panel off. */
const SCREEN_OFF_FAST_FOR_MS = 30_000;

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

  private constructor(
    private readonly client: AdbScrcpyClient<AdbScrcpyOptionsLatest<false>>,
    /** Kept for the shell calls scrcpy's control channel has no message for. */
    private readonly adb: Adb,
  ) {}

  get controller(): ScrcpyControlMessageWriter {
    const controller = this.client.controller;
    if (!controller) throw new Error("control disabled");
    return controller;
  }

  static async start(
    adb: Adb,
    options: {
      audio?: boolean;
      powerOffOnClose?: boolean;
      screenOffTimeoutMs?: number;
      /** Wake a device that is already dozing. For a viewer session, which
       * also holds the screen-off timeout so it stays awake; not for the idle
       * keeper, which would only wake it to watch it doze again. */
      wakeOnStart?: boolean;
    } = {},
  ): Promise<DeviceSession> {
    const withAudio = options.audio ?? true;
    const powerOffOnClose = options.powerOffOnClose ?? false;
    // Unique jar per instance — see pushServer for the unlink race this avoids.
    const serverPath = await pushServer(adb);
    let client;
    try {
      client = await AdbScrcpyClient.start(
        adb,
        serverPath,
        makeControlOptions(withAudio, powerOffOnClose, options.screenOffTimeoutMs),
      );
    } catch (error) {
      void removeServer(adb, serverPath);
      throw error;
    }
    const session = new DeviceSession(client, adb);
    session.powerOffOnClose = powerOffOnClose;
    // Mirroring does not keep Android awake on its own, so a device left alone
    // is often already dozing by the time someone opens it — and a dozing
    // device composes nothing, so the first frames are stale and everything
    // after them is black.
    if (options.wakeOnStart) await session.wakeIfDozing();

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
  /**
   * Bring the device out of doze before darkening the panel.
   *
   * Powering the panel off keeps the system awake only until its own
   * inactivity timer runs out; after that Android dozes, and a dozing device
   * composes nothing — the mirror goes black a moment after connecting, and so
   * does `screencap`. Measured on a real device: dozing gave a pure black
   * frame, and a single wake key brought it back. Pressing anything (which is
   * how this was noticed — the 返回 button "fixed" it) does the same thing by
   * accident. `screen_off_timeout` keeps it awake from then on.
   */
  async wakeIfDozing(): Promise<void> {
    try {
      const power = await sh(this.adb, "dumpsys power | grep -m1 mWakefulness=");
      if (/mWakefulness=Awake/.test(power)) return;
      console.log(`[screen] 裝置在休眠(${power.trim()}),先喚醒再關面板`);
      await sh(this.adb, "input keyevent KEYCODE_WAKEUP");
    } catch {
      /* worst case the panel goes dark on a dozing device, as it did before */
    }
  }

  setScreenOff(off: boolean): void {
    this.screenOff = off;
    if (this.screenOffTimer) {
      clearTimeout(this.screenOffTimer);
      this.screenOffTimer = undefined;
    }
    if (off) {
      // Wake first: darkening a dozing device leaves it dozing, and nothing to
      // watch. The panel goes off immediately after, so nobody sees it light up.
      void this.wakeIfDozing().then(() => this.applyScreenPower(AndroidScreenPowerMode.Off));
      const startedAt = Date.now();
      const reassert = () => {
        if (this.closed) return;
        const fast = Date.now() - startedAt < SCREEN_OFF_FAST_FOR_MS;
        // Re-asserting off does nothing for a device that has dozed: it stops
        // composing, so the mirror is black and another off command changes
        // nothing. Nothing here used to notice, which is why the picture stayed
        // black until someone pressed 返回. The check that catches it is a
        // `dumpsys`, so it rides the slow ticks only — where one shell call per
        // half-minute is affordable.
        if (fast) void this.applyScreenPower(AndroidScreenPowerMode.Off);
        else void this.wakeIfDozing().then(() => this.applyScreenPower(AndroidScreenPowerMode.Off));
        this.screenOffTimer = setTimeout(reassert, fast ? SCREEN_OFF_FAST_MS : SCREEN_OFF_SLOW_MS);
      };
      this.screenOffTimer = setTimeout(reassert, SCREEN_OFF_FAST_MS);
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
    if (this.screenOffTimer) clearTimeout(this.screenOffTimer);
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
    // The screen-off re-assert makes the server say "Device display turned off"
    // every 3 seconds for as long as the instance lives. Saying it once is
    // information; saying it 1200 times an hour buries everything else.
    let previous = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const line = value.trim();
        if (!line || line === previous) continue;
        previous = line;
        console.log(`[scrcpy:control] ${line}`);
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
