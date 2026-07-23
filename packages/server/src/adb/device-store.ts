import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KnownDevice {
  /** For wireless adb devices the serial IS the "ip:port" address. */
  address: string;
  name: string;
  autoConnect: boolean;
}

export class DeviceStore {
  private readonly path: string;
  private devices = new Map<string, KnownDevice>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "devices.json");
    if (existsSync(this.path)) {
      const list = JSON.parse(readFileSync(this.path, "utf8")) as KnownDevice[];
      for (const device of list) this.devices.set(device.address, device);
    }
  }

  list(): KnownDevice[] {
    return [...this.devices.values()];
  }

  get(address: string): KnownDevice | undefined {
    return this.devices.get(address);
  }

  upsert(device: KnownDevice): void {
    this.devices.set(device.address, device);
    this.save();
  }

  update(address: string, patch: Partial<Omit<KnownDevice, "address">>): void {
    const existing = this.devices.get(address);
    if (!existing) return;
    this.devices.set(address, { ...existing, ...patch });
    this.save();
  }

  remove(address: string): void {
    this.devices.delete(address);
    this.save();
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2));
  }
}
