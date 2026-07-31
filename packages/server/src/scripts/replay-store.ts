import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptLogEntry } from "@speedcrcpy/shared";
import { framePng, type Frame } from "./vision.js";

/** One recorded run: what to show in the picker before opening it. */
export interface ReplaySummary {
  runId: string;
  serial: string;
  scriptId: string;
  scriptName: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "done" | "stopped" | "error";
  frames: number;
  bytes: number;
}

/** A recorded run in full: the frames, when each was taken, and the run's log so
 * the player can say what the script was doing at that moment. */
export interface ReplayIndex extends ReplaySummary {
  /** Pixel size of the stored frames (they are downscaled). */
  width: number;
  height: number;
  shots: { at: number }[];
  log: ScriptLogEntry[];
}

export interface ReplaySettings {
  enabled: boolean;
  /** Floor between recorded frames. A findTap step captures roughly twice a
   * second; without this, one waiting screen would fill the whole allowance. */
  intervalSec: number;
  /** Ceiling on everything under `replays/`, oldest run evicted first. */
  maxMb: number;
  /** Stored frame width in pixels. */
  width: number;
}

const INDEX_FILE = "index.json";

/**
 * Screenshots a run already took, kept as a timelapse of what the device was
 * doing.
 *
 * No frame is captured for this: a script screencaps on every poll anyway, and
 * those frames are handed here on the way past (the same donation that feeds the
 * thumbnail cache). The consequence is visible in playback and is the honest
 * one — a step that needs no picture (a wait, a swipe, typing) produces no
 * frames, so the timeline has gaps where the script wasn't looking.
 *
 * Storage is bounded by total size rather than by a number of runs, so how far
 * back you can see depends on how long the runs were.
 */
export class ReplayStore {
  private readonly root: string;
  private readonly runs = new Map<string, ReplayIndex>();
  /** Per-run recording state, only while it is running. */
  private readonly active = new Map<string, { dir: string; lastAt: number; writing: boolean }>();

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

  /** Bytes on disk across every recorded run. */
  usage(): number {
    let total = 0;
    for (const run of this.runs.values()) total += run.bytes;
    return total;
  }

  list(scriptId?: string): ReplaySummary[] {
    return [...this.runs.values()]
      .filter((run) => !scriptId || run.scriptId === scriptId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ shots: _shots, log: _log, ...summary }) => summary);
  }

  get(runId: string): ReplayIndex | undefined {
    return this.runs.get(runId);
  }

  framePath(runId: string, n: number): string | undefined {
    const run = this.runs.get(runId);
    if (!run || n < 0 || n >= run.shots.length) return undefined;
    return join(this.root, runId, frameName(n));
  }

  begin(info: Omit<ReplaySummary, "endedAt" | "outcome" | "frames" | "bytes">): void {
    if (!this.settings.enabled) return;
    const dir = join(this.root, info.runId);
    mkdirSync(dir, { recursive: true });
    this.runs.set(info.runId, {
      ...info,
      endedAt: null,
      outcome: "running",
      frames: 0,
      bytes: 0,
      width: 0,
      height: 0,
      shots: [],
      log: [],
    });
    this.active.set(info.runId, { dir, lastAt: 0, writing: false });
    this.writeIndex(info.runId);
  }

  /**
   * Offer a frame the run just captured. Dropped unless the floor has passed,
   * and dropped while a previous frame is still being written — encoding is
   * synchronous, and a run must never wait on its own recording.
   */
  offer(runId: string, frame: Frame): void {
    const state = this.active.get(runId);
    const run = this.runs.get(runId);
    if (!state || !run || state.writing) return;
    const now = Date.now();
    if (now - state.lastAt < this.settings.intervalSec * 1000) return;
    state.lastAt = now;
    state.writing = true;
    try {
      const png = framePng(frame, this.settings.width);
      const n = run.shots.length;
      writeFileSync(join(state.dir, frameName(n)), png);
      run.shots.push({ at: now });
      run.frames = run.shots.length;
      run.bytes += png.byteLength;
      if (!run.width) {
        const scale = Math.min(1, this.settings.width / frame.width);
        run.width = Math.max(1, Math.round(frame.width * scale));
        run.height = Math.max(1, Math.round(frame.height * scale));
      }
      // Rewritten every frame so the player can follow a run in progress.
      this.writeIndex(runId);
    } catch {
      /* a dropped frame is not worth failing a run over */
    } finally {
      state.writing = false;
    }
  }

  finish(runId: string, outcome: ReplaySummary["outcome"], log: ScriptLogEntry[]): void {
    const run = this.runs.get(runId);
    this.active.delete(runId);
    if (!run) return;
    run.endedAt = Date.now();
    run.outcome = outcome;
    run.log = log;
    // A run that recorded nothing (all waits, or recording switched off
    // mid-run) is not worth a row in the picker.
    if (!run.shots.length) {
      this.remove(runId);
      return;
    }
    this.writeIndex(runId);
    this.prune();
  }

  /** Oldest-first eviction, by whole runs: half a run is not worth keeping. */
  private prune(): void {
    const limit = this.settings.maxMb * 1024 * 1024;
    const oldestFirst = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    let total = this.usage();
    for (const run of oldestFirst) {
      if (total <= limit) break;
      if (this.active.has(run.runId)) continue; // never evict what is recording now
      total -= run.bytes;
      this.remove(run.runId);
    }
  }

  private remove(runId: string): void {
    this.runs.delete(runId);
    this.active.delete(runId);
    rmSync(join(this.root, runId), { recursive: true, force: true });
  }

  private writeIndex(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    writeFileSync(join(this.root, runId, INDEX_FILE), JSON.stringify(run));
  }

  /** Read what previous sessions recorded. A run left as "running" by a server
   * that stopped mid-run is closed here — it is not going to produce more. */
  private load(): void {
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(this.root, entry.name, INDEX_FILE);
      if (!existsSync(file)) continue;
      try {
        const run = JSON.parse(readFileSync(file, "utf8")) as ReplayIndex;
        if (run.outcome === "running") {
          run.outcome = "error";
          run.endedAt = run.shots.at(-1)?.at ?? run.startedAt;
        }
        run.bytes = dirBytes(join(this.root, entry.name));
        this.runs.set(run.runId, run);
      } catch {
        /* unreadable index — drop the directory rather than keep a run nobody can play */
        rmSync(join(this.root, entry.name), { recursive: true, force: true });
      }
    }
    this.prune();
  }
}

const frameName = (n: number): string => `${String(n).padStart(5, "0")}.png`;

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    try {
      total += statSync(join(dir, entry)).size;
    } catch {
      /* raced with a prune */
    }
  }
  return total;
}
