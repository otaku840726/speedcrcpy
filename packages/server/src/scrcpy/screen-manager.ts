import type { DeviceInfo } from "@speedcrcpy/shared";
import type { AdbManager } from "../adb/adb-manager.js";
import { DeviceSession } from "./device-session.js";

/**
 * Keeps the physical screen of every connected device off, independent of
 * whether anyone is mirroring it.
 *
 * There is no adb CLI that powers the panel off while keeping the display
 * capturable, so each connected device gets a lightweight control-only scrcpy
 * instance (no video, no audio) that asserts screen-off and re-asserts on a
 * timer. While a real viewer session owns a device, its own control instance
 * handles screen-off (and the in-session toggle), so the keeper steps aside to
 * avoid a second control instance fighting the user's toggle.
 */
export class ScreenManager {
  private readonly keepers = new Map<string, KeeperState>();
  private readonly sessionActive = new Set<string>();

  constructor(
    private readonly adbManager: AdbManager,
    private readonly enabled: boolean,
  ) {}

  start(): void {
    if (!this.enabled) return;
    this.adbManager.onDevicesChange((devices) => this.sync(devices));
    this.sync(this.adbManager.deviceInfos());
  }

  /** Called by SessionManager: a viewer session took/released a device. */
  setSessionActive(serial: string, active: boolean): void {
    if (!this.enabled) return;
    if (active) {
      this.sessionActive.add(serial);
      void this.stopKeeper(serial);
    } else {
      this.sessionActive.delete(serial);
      // Re-assert on the next sync; do it now if still connected.
      if (this.adbManager.deviceInfos().some((d) => d.serial === serial && d.state === "device")) {
        void this.startKeeper(serial);
      }
    }
  }

  async stop(): Promise<void> {
    const serials = [...this.keepers.keys()];
    await Promise.allSettled(serials.map((serial) => this.stopKeeper(serial)));
  }

  private sync(devices: DeviceInfo[]): void {
    const connected = new Set(devices.filter((d) => d.state === "device").map((d) => d.serial));

    for (const serial of connected) {
      if (!this.sessionActive.has(serial)) void this.startKeeper(serial);
    }
    for (const serial of [...this.keepers.keys()]) {
      if (!connected.has(serial)) void this.stopKeeper(serial);
    }
  }

  private async startKeeper(serial: string): Promise<void> {
    const existing = this.keepers.get(serial);
    if (existing) return; // already running or starting

    const state: KeeperState = { starting: true, session: undefined };
    this.keepers.set(serial, state);
    try {
      const adb = await this.adbManager.getAdb(serial);
      // Re-check: the device may have gained a session or dropped while we
      // were opening the transport.
      if (this.sessionActive.has(serial) || this.keepers.get(serial) !== state) {
        this.keepers.delete(serial);
        return;
      }
      // powerOffOnClose: keep the screen off even if this keeper dies uncleanly
      // (container killed, device dropped) instead of the panel being restored.
      const session = await DeviceSession.start(adb, { audio: false, powerOffOnClose: true });
      state.session = session;
      state.starting = false;
      session.setScreenOff(true);
      session.onExit(() => {
        if (this.keepers.get(serial) === state) this.keepers.delete(serial);
      });
      console.log(`[screen] keeping ${serial} screen off`);
    } catch (error) {
      this.keepers.delete(serial);
      console.warn(`[screen] failed to start keeper for ${serial}: ${(error as Error).message}`);
    }
  }

  private async stopKeeper(serial: string): Promise<void> {
    const state = this.keepers.get(serial);
    if (!state) return;
    this.keepers.delete(serial);
    // Don't restore the panel: the keeper only stops because a session is
    // taking over screen-off, or the device disconnected (restore is a no-op).
    // Keeping it off through the handover avoids an on/off flicker.
    if (state.session) await state.session.close(false).catch(() => {});
  }
}

interface KeeperState {
  starting: boolean;
  session: DeviceSession | undefined;
}
