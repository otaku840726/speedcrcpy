import {
  AdbBanner,
  type AdbFeature,
  type AdbIncomingSocketHandler,
  AdbNoneProtocolSpawner,
  AdbServerClient,
  AdbShellProtocolSpawner,
  type AdbSocket,
  type AdbTransport,
  ADB_SERVER_DEFAULT_FEATURES,
} from "@yume-chan/adb";
import { ConcatBufferStream, ConcatStringStream, TextDecoderStream } from "@yume-chan/stream-extra";

class ResolvablePromise<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

let globalSocketsCreated = 0;
let globalSocketsClosed = 0;
const activeTransports = new Set<PatchedAdbServerTransport>();

/**
 * Patched AdbServerTransport that prunes closed sockets.
 *
 * Upstream `@yume-chan/adb` (<= 2.6.0) stores every created socket in an internal
 * `#sockets` array (`this.#sockets.push(socket)`) and only clears it in `close()`.
 * For long-running servers that reuse an Adb instance across repeated background
 * operations (device stats every 5s, thumbnails every 10s, wakefulness checks every 30s),
 * this array accumulates hundreds of thousands of dead socket objects, controllers,
 * and streams (~3,600 sockets/hour for 3 devices, ~360,000 sockets over 4 days),
 * exhausting the 4 GB V8 heap and crashing Node with:
 * "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory".
 *
 * This patched transport removes sockets as soon as `socket.closed` settles.
 */
export class PatchedAdbServerTransport implements AdbTransport {
  readonly serial: string;
  readonly transportId: bigint;
  readonly maxPayloadSize = 1 * 1024 * 1024;
  readonly banner: AdbBanner;
  readonly disconnected: Promise<void>;
  readonly clientFeatures: readonly AdbFeature[] = ADB_SERVER_DEFAULT_FEATURES;

  private readonly client: AdbServerClient;
  private readonly sockets = new Set<AdbSocket>();
  private readonly closedResolvers = new ResolvablePromise<void>();
  private localSocketsCreated = 0;
  private localSocketsClosed = 0;

  constructor(
    client: AdbServerClient,
    serial: string,
    banner: AdbBanner,
    transportId: bigint,
    disconnected: Promise<void>,
  ) {
    this.client = client;
    this.serial = serial;
    this.banner = banner;
    this.transportId = transportId;
    this.disconnected = Promise.race([this.closedResolvers.promise, disconnected]);
    activeTransports.add(this);
    void this.disconnected.finally(() => {
      activeTransports.delete(this);
      void this.close();
    });
  }

  get activeSockets(): number {
    return this.sockets.size;
  }

  get totalCreated(): number {
    return this.localSocketsCreated;
  }

  get totalClosed(): number {
    return this.localSocketsClosed;
  }

  async connect(service: string): Promise<AdbSocket> {
    const socket = await this.client.createDeviceConnection({ transportId: this.transportId }, service);
    this.sockets.add(socket);
    this.localSocketsCreated++;
    globalSocketsCreated++;

    void socket.closed.finally(() => {
      if (this.sockets.delete(socket)) {
        this.localSocketsClosed++;
        globalSocketsClosed++;
      }
    });

    return socket;
  }

  async addReverseTunnel(handler: AdbIncomingSocketHandler, address?: string): Promise<string> {
    return await this.client.connector.addReverseTunnel(handler, address);
  }

  async removeReverseTunnel(address: string): Promise<void> {
    await this.client.connector.removeReverseTunnel(address);
  }

  async clearReverseTunnels(): Promise<void> {
    await this.client.connector.clearReverseTunnels();
  }

  async close(): Promise<void> {
    activeTransports.delete(this);
    const pending = Array.from(this.sockets);
    this.sockets.clear();
    for (const socket of pending) {
      try {
        await socket.close();
      } catch {
        /* ignore */
      }
      this.localSocketsClosed++;
      globalSocketsClosed++;
    }
    this.closedResolvers.resolve();
  }
}

export function getAdbSocketStats(): {
  activeSockets: number;
  totalCreated: number;
  totalClosed: number;
  activeTransports: number;
} {
  let activeSockets = 0;
  for (const transport of activeTransports) {
    activeSockets += transport.activeSockets;
  }
  return {
    activeSockets,
    totalCreated: globalSocketsCreated,
    totalClosed: globalSocketsClosed,
    activeTransports: activeTransports.size,
  };
}

let patchesApplied = false;

/**
 * Apply runtime monkey-patches to @yume-chan/adb to eliminate memory leaks:
 * 1. Replaces `AdbServerClient.prototype.createTransport` to use `PatchedAdbServerTransport`
 *    so closed sockets are pruned from memory immediately.
 * 2. Wraps `AdbShellProtocolSpawner.prototype.spawnWait` and `spawnWaitText` so the underlying
 *    process/socket is explicitly closed via `process.kill()` as soon as the result is gathered.
 * 3. Wraps `AdbNoneProtocolSpawner.prototype.spawnWait` and `spawnWaitText` similarly.
 */
export function applyAdbPatches(): void {
  if (patchesApplied) return;
  patchesApplied = true;

  // 1. Patch createTransport
  AdbServerClient.prototype.createTransport = async function (device: AdbServerClient.DeviceSelector) {
    const { transportId, features } = await this.getDeviceFeatures(device);
    const devices = await this.getDevices();
    const info = devices.find((d) => d.transportId === transportId);
    const banner = new AdbBanner(info?.state, info?.product, info?.model, info?.device, features);
    const waitAbortController = new AbortController();
    const disconnected = this.waitForDisconnect(transportId, {
      unref: true,
      signal: waitAbortController.signal,
    });
    const transport = new PatchedAdbServerTransport(this, info?.serial ?? "", banner, transportId, disconnected);
    void transport.disconnected.finally(() => waitAbortController.abort());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return transport as any;
  };

  // 2. Patch AdbShellProtocolSpawner to guarantee socket closure on completion
  AdbShellProtocolSpawner.prototype.spawnWait = async function (command: string | readonly string[]) {
    const proc = await this.spawn(command);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout.pipeThrough(new ConcatBufferStream()),
        proc.stderr.pipeThrough(new ConcatBufferStream()),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      void proc.kill();
    }
  };

  AdbShellProtocolSpawner.prototype.spawnWaitText = async function (command: string | readonly string[]) {
    const proc = await this.spawn(command);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new ConcatStringStream()),
        proc.stderr
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new ConcatStringStream()),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } finally {
      void proc.kill();
    }
  };

  // 3. Patch AdbNoneProtocolSpawner to guarantee socket closure on completion
  AdbNoneProtocolSpawner.prototype.spawnWait = async function (command: string | readonly string[]) {
    const proc = await this.spawn(command);
    try {
      return await proc.output.pipeThrough(new ConcatBufferStream());
    } finally {
      void proc.kill();
    }
  };

  AdbNoneProtocolSpawner.prototype.spawnWaitText = async function (command: string | readonly string[]) {
    const proc = await this.spawn(command);
    try {
      return await proc.output
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new ConcatStringStream());
    } finally {
      void proc.kill();
    }
  };

  console.log("[adb-patch] Applied socket-leak and auto-close fixes to @yume-chan/adb");
}
