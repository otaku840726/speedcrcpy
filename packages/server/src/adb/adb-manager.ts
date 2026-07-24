import type { DeviceInfo } from "@speedcrcpy/shared";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import { DeviceStore } from "./device-store.js";

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

class TimeoutError extends Error {
  constructor() {
    super("timeout");
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class AdbManager {
  readonly client: AdbServerClient;
  readonly store: DeviceStore;

  private observer: AdbServerClient.DeviceObserver | undefined;
  private live: readonly AdbServerClient.Device[] = [];
  private readonly listeners = new Set<(devices: DeviceInfo[]) => void>();
  private readonly reconnectState = new Map<string, { delay: number; nextAt: number }>();
  private reconnectTimer: NodeJS.Timeout | undefined;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly adbCache = new Map<string, Adb>();

  constructor(private readonly config: Config) {
    this.client = new AdbServerClient(
      new AdbServerNodeTcpConnector({ host: config.adbHost, port: config.adbPort }),
    );
    this.store = new DeviceStore(config.dataDir);
  }

  async start(): Promise<void> {
    // Tango's device-track socket is unref'd and its own keep-alive only
    // starts after the first payload — hold our own ref so the process
    // never exits mid-await (bites CLI tools and pre-listen server startup).
    this.keepAliveTimer = setInterval(() => {}, 60_000);
    await this.ensureAdbServer();
    this.observer = await this.client.trackDevices();
    this.live = this.observer.current;
    this.observer.onListChange((devices) => {
      this.live = devices;
      this.rememberConnected();
      this.notify();
    });
    this.observer.onError((error) => {
      console.error("[adb] device observer error:", error.message);
    });
    this.rememberConnected();
    this.scheduleReconnectLoop();
  }

  /** The adb server owns pairing keys and reconnects; start it if not running. */
  private async ensureAdbServer(): Promise<void> {
    try {
      await this.client.getVersion();
      return;
    } catch {
      console.log("[adb] adb server not reachable, running `adb start-server`...");
    }

    // `adb start-server` forks a daemon that inherits stdio and never closes
    // it, so wait for the exit event with stdio ignored — not for stream end.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("adb", ["start-server"], { stdio: "ignore" });
      child.on("exit", () => resolve());
      child.on("error", reject);
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this.client.getVersion();
        return;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    throw lastError;
  }

  onDevicesChange(listener: (devices: DeviceInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live adb devices merged with known-but-offline stored devices. */
  deviceInfos(): DeviceInfo[] {
    const infos: DeviceInfo[] = [];
    const liveSerials = new Set<string>();

    for (const device of this.live) {
      liveSerials.add(device.serial);
      const known = this.store.get(device.serial);
      infos.push({
        serial: device.serial,
        name: known?.name || device.model || device.product || device.serial,
        state: device.state === "device" ? "device" : device.state === "offline" ? "offline" : "unauthorized",
        address: known?.address,
        autoConnect: known?.autoConnect ?? false,
      });
    }

    for (const known of this.store.list()) {
      if (!liveSerials.has(known.address)) {
        infos.push({
          serial: known.address,
          name: known.name,
          state: "disconnected",
          address: known.address,
          autoConnect: known.autoConnect,
        });
      }
    }

    return infos.sort((a, b) => a.serial.localeCompare(b.serial));
  }

  async connect(address: string): Promise<void> {
    try {
      // adb blocks until the TCP attempt times out (minutes for unroutable
      // addresses) — cap the API wait; adb keeps trying in the background.
      await withTimeout(this.client.wireless.connect(address), 15_000);
    } catch (error) {
      if (!(error instanceof AdbServerClient.AlreadyConnectedError)) throw error;
    }
    if (!this.store.get(address)) {
      this.store.upsert({ address, name: address, autoConnect: true });
    }
    this.reconnectState.delete(address);
    this.notify();
  }

  async pair(address: string, code: string): Promise<void> {
    await this.client.wireless.pair(address, code);
  }

  async disconnect(address: string): Promise<void> {
    // Explicit disconnect also disables auto-reconnect, otherwise the loop
    // would immediately undo the user's action.
    this.store.update(address, { autoConnect: false });
    await this.client.wireless.disconnect(address).catch(() => {});
    this.notify();
  }

  async forget(address: string): Promise<void> {
    this.store.remove(address);
    await this.client.wireless.disconnect(address).catch(() => {});
    this.notify();
  }

  setAutoConnect(address: string, autoConnect: boolean): void {
    this.store.update(address, { autoConnect });
    if (autoConnect) this.reconnectState.delete(address);
    this.notify();
  }

  async createAdb(serial: string): Promise<Adb> {
    return this.client.createAdb({ serial });
  }

  /**
   * Cached Adb per serial for lightweight repeated commands (thumbnails).
   * A broken transport is discarded and recreated on the next call.
   */
  async getAdb(serial: string): Promise<Adb> {
    const cached = this.adbCache.get(serial);
    if (cached) return cached;
    const adb = await this.client.createAdb({ serial });
    this.adbCache.set(serial, adb);
    void adb.disconnected.finally(() => {
      if (this.adbCache.get(serial) === adb) this.adbCache.delete(serial);
    });
    return adb;
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    await this.observer?.stop();
  }

  /** Update stored name once a wireless device is online and reports its model. */
  private rememberConnected(): void {
    for (const device of this.live) {
      const known = this.store.get(device.serial);
      if (known && device.model && known.name !== device.model) {
        this.store.update(device.serial, { name: device.model });
      }
    }
  }

  private notify(): void {
    const infos = this.deviceInfos();
    for (const listener of this.listeners) listener(infos);
  }

  private scheduleReconnectLoop(): void {
    if (this.closed) return;
    this.reconnectTimer = setTimeout(async () => {
      await this.reconnectMissing();
      this.scheduleReconnectLoop();
    }, RECONNECT_BASE_MS);
  }

  /** Try to reconnect stored autoConnect devices that are not currently live. */
  private async reconnectMissing(): Promise<void> {
    const liveSerials = new Set(this.live.map((d) => d.serial));
    const now = Date.now();

    for (const known of this.store.list()) {
      if (!known.autoConnect || liveSerials.has(known.address)) {
        this.reconnectState.delete(known.address);
        continue;
      }

      const state = this.reconnectState.get(known.address) ?? { delay: 0, nextAt: 0 };
      if (now < state.nextAt) continue;

      const nextDelay = Math.min(state.delay === 0 ? RECONNECT_BASE_MS : state.delay * 2, RECONNECT_MAX_MS);
      this.reconnectState.set(known.address, { delay: nextDelay, nextAt: now + nextDelay });

      try {
        await this.client.wireless.connect(known.address);
        this.reconnectState.delete(known.address);
        console.log(`[adb] reconnected ${known.address}`);
      } catch {
        // Expected while the device is unreachable; retry with backoff.
      }
    }
  }
}
