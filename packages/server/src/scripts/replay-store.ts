import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { framePng, type Frame } from "./vision.js";

/** One recorded screen, addressed by when it was taken. */
export interface Shot {
  at: number;
  bytes: number;
}

/** Something a script did, to show against the picture from that moment. */
export interface ReplayEvent {
  at: number;
  message: string;
  scriptName: string;
}

export interface ReplayWindow {
  shots: { at: number }[];
  events: ReplayEvent[];
  /** What exists on disk for this device, whatever window was asked for. */
  first: number | null;
  last: number | null;
}

export interface ReplaySettings {
  enabled: boolean;
  /**
   * Floor between recorded frames. Nothing is captured for the replay, so this
   * only ever throttles: idle cadence is whatever the thumbnail loop runs at
   * (10s by default), and a running script offers frames far faster than this.
   */
  intervalSec: number;
  /** Ceiling on everything under `replays/`, oldest frame evicted first. */
  maxMb: number;
  /** Stored frame width in pixels. */
  width: number;
}

const INDEX_FILE = "index.json";
/** Rewriting a device's index on every frame would be the most frequent write
 * in the process; a run in progress only needs it fresh enough to follow. */
const INDEX_FLUSH_MS = 5_000;

/**
 * A rolling timelapse of each device, made of screenshots that were taken
 * anyway.
 *
 * Two sources, one recording: the thumbnail cache screencaps every connected
 * device on its own timer, and a running script screencaps far more often.
 * Both hand their frame here on the way past, so the device is recorded
 * whether or not anything is automating it — the difference a script makes is
 * that the timeline gets denser and gains events to read against the picture.
 *
 * Bounded by total size, oldest frame first. How far back that reaches depends
 * on how many devices are connected and how much of the time scripts were
 * running, which is why the panel shows the span rather than a promise.
 */
export class ReplayStore {
  private readonly root: string;
  /** Per device, in capture order. */
  private readonly shots = new Map<string, Shot[]>();
  private readonly events = new Map<string, ReplayEvent[]>();
  private readonly lastShotAt = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private flushedAt = 0;
  private total = 0;

  constructor(
    dataDir: string,
    private settings: ReplaySettings,
  ) {
    this.root = join(dataDir, "replays");
    mkdirSync(this.root, { recursive: true });
    this.load();
  }

  configure(settings: ReplaySettings): void {
    this.settings = settings;
    this.prune();
  }

  current(): ReplaySettings {
    return this.settings;
  }

  usage(): number {
    return this.total;
  }

  devices(): string[] {
    return [...this.shots.keys()];
  }

  /** How many entries are being held in memory, for the health heartbeat.
   * Both lists are meant to stay bounded by the disk cap — a number that
   * climbs all day says the pruning is not reaching them. */
  counts(): { shots: number; events: number } {
    let shots = 0;
    let events = 0;
    for (const list of this.shots.values()) shots += list.length;
    for (const list of this.events.values()) events += list.length;
    return { shots, events };
  }

  /**
   * Everything recorded for a device between two times. Events are included
   * from slightly before the window so a run that started earlier still says
   * what it was doing.
   */
  window(serial: string, from: number, to: number): ReplayWindow {
    const shots = this.shots.get(serial) ?? [];
    const events = this.events.get(serial) ?? [];
    return {
      shots: shots.filter((s) => s.at >= from && s.at <= to).map(({ at }) => ({ at })),
      events: events.filter((e) => e.at >= from && e.at <= to),
      first: shots[0]?.at ?? null,
      last: shots.at(-1)?.at ?? null,
    };
  }

  framePath(serial: string, at: number): string | undefined {
    const shots = this.shots.get(serial) ?? [];
    return shots.some((s) => s.at === at) ? join(this.root, serial, `${at}.png`) : undefined;
  }

  /**
   * Take a frame someone else captured. Dropped unless the floor has passed —
   * during a script run they arrive about twice a second.
   */
  offer(serial: string, frame: Frame): void {
    if (!this.settings.enabled) return;
    const now = Date.now();
    if (now - (this.lastShotAt.get(serial) ?? 0) < this.settings.intervalSec * 1000) return;
    this.lastShotAt.set(serial, now);
    try {
      const png = framePng(frame, this.settings.width);
      const dir = join(this.root, serial);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${now}.png`), png);
      const shots = this.shots.get(serial) ?? [];
      shots.push({ at: now, bytes: png.byteLength });
      this.shots.set(serial, shots);
      this.total += png.byteLength;
      this.dirty.add(serial);
      this.flush(now);
      this.prune();
    } catch {
      /* a dropped frame is not worth failing the caller's capture over */
    }
  }

  /** A line from a script run, kept beside the pictures of the same moment. */
  note(serial: string, scriptName: string, message: string): void {
    if (!this.settings.enabled) return;
    const events = this.events.get(serial) ?? [];
    events.push({ at: Date.now(), message, scriptName });
    this.events.set(serial, events);
    this.dirty.add(serial);
    this.flush(Date.now());
  }

  private flush(now: number, force = false): void {
    if (!force && now - this.flushedAt < INDEX_FLUSH_MS) return;
    this.flushedAt = now;
    for (const serial of this.dirty) {
      const dir = join(this.root, serial);
      if (!existsSync(dir)) continue;
      writeFileSync(
        join(dir, INDEX_FILE),
        JSON.stringify({ shots: this.shots.get(serial) ?? [], events: this.events.get(serial) ?? [] }),
      );
    }
    this.dirty.clear();
  }

  /**
   * Oldest frame first, across every device — the cap is on the recording as a
   * whole, so a device that ran a script all night does not get to keep its
   * history at the expense of one that only has a day of idle frames.
   */
  private prune(): void {
    const limit = this.settings.maxMb * 1024 * 1024;
    if (this.total <= limit) return;
    while (this.total > limit) {
      let oldest: { serial: string; shot: Shot } | undefined;
      for (const [serial, shots] of this.shots) {
        const first = shots[0];
        if (first && (!oldest || first.at < oldest.shot.at)) oldest = { serial, shot: first };
      }
      if (!oldest) break;
      const shots = this.shots.get(oldest.serial)!;
      shots.shift();
      this.total -= oldest.shot.bytes;
      try {
        unlinkSync(join(this.root, oldest.serial, `${oldest.shot.at}.png`));
      } catch {
        /* already gone */
      }
      // Events older than the oldest surviving picture have nothing to caption.
      const cutoff = shots[0]?.at ?? Infinity;
      const events = (this.events.get(oldest.serial) ?? []).filter((e) => e.at >= cutoff);
      this.events.set(oldest.serial, events);
      this.dirty.add(oldest.serial);
      if (!shots.length) {
        this.shots.delete(oldest.serial);
        this.events.delete(oldest.serial);
        rmSync(join(this.root, oldest.serial), { recursive: true, force: true });
        this.dirty.delete(oldest.serial);
      }
    }
    this.flush(Date.now(), true);
  }

  /** Read back what earlier sessions recorded, trusting the files over the
   * index: a process killed between a frame and a flush leaves both behind. */
  private load(): void {
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.root, entry.name);
      const shots: Shot[] = [];
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".png")) continue;
        const at = Number(file.slice(0, -4));
        if (!Number.isFinite(at)) continue;
        try {
          shots.push({ at, bytes: statSync(join(dir, file)).size });
        } catch {
          /* raced with a prune */
        }
      }
      if (!shots.length) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      shots.sort((a, b) => a.at - b.at);
      this.shots.set(entry.name, shots);
      this.total += shots.reduce((sum, s) => sum + s.bytes, 0);

      const index = join(dir, INDEX_FILE);
      if (existsSync(index)) {
        try {
          const saved = JSON.parse(readFileSync(index, "utf8")) as { events?: ReplayEvent[] };
          this.events.set(entry.name, saved.events ?? []);
        } catch {
          /* an unreadable index costs the captions, not the pictures */
        }
      }
    }
    this.prune();
  }
}
