import { type ChildProcess, fork } from "node:child_process";
import type { OcrResult } from "./ocr.js";
import { memoryLine } from "./vision-health.js";
import type { Frame, MatchResult, Region } from "./vision.js";
import type { VisionRequest, VisionResponse } from "./vision.worker.js";

/**
 * Server-side of the vision process: same call signatures as the functions it
 * replaces, so callers are unaware anything moved.
 *
 * One process, requests served in order. Vision steps are already sequential
 * within a run, and the models cost ~1.5 s to load — a pool would multiply that
 * and let two devices fight over CPU that the mirror also needs.
 *
 * The process is replaced rather than kept forever. Text recognition holds a
 * WebAssembly heap that only grows (see vision.worker.ts), so a long-lived one
 * ends at its 1 GiB ceiling with every text step failing; a replacement starts
 * at zero. The cost of replacing is one model load, ~1.5 s, which is why it is
 * done on a call count rather than per call — amortised over MAX_CALLS it is
 * about 10 ms a call, against the ~480 ms a recognition takes anyway.
 */

/** Well below the first growth step measured in a soak (which came at ~150). */
const MAX_CALLS = 120;
/**
 * The WebAssembly heap is what actually fails, at 1024 MB, so it is watched
 * directly and replaced well before it gets there. Only visible on Linux (it
 * comes from /proc), which is where it has ever mattered.
 */
const MAX_BLOCK_MB = 700;
/**
 * Last-resort backstop on the whole process. Deliberately far above what a
 * healthy one uses — measured at ~860 MB on macOS with the models resident, so
 * anything lower fires constantly and turns every few calls into a model
 * reload, which is worse than the leak.
 */
const MAX_RSS_MB = 1600;
/** Nothing to serve — hand the memory back rather than sit on ~500 MB. */
const IDLE_EXIT_MS = 60_000;
/** How often to say what it is holding, in calls. */
const REPORT_EVERY = 50;

let child: ChildProcess | undefined;
let callsServed = 0;
let idleTimer: NodeJS.Timeout | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function start(): ChildProcess {
  // Sibling of this module in both layouts: `src/scripts/` when run from
  // source, and the flattened `dist/` after bundling.
  const file = new URL(import.meta.url.endsWith(".ts") ? "./vision.worker.ts" : "./vision.worker.js", import.meta.url);
  // `advanced` serialization keeps a frame's pixels a Uint8Array over the pipe;
  // the default JSON encoding would turn 8 MB of pixels into an array of eight
  // million numbers. `execArgv` carries the dev-mode TypeScript loader through.
  const next = fork(file, [], {
    serialization: "advanced",
    execArgv: process.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  // Idle, it must not hold the server open; with a request in flight it must,
  // or a caller waiting on a reply finds the event loop empty underneath it.
  next.unref();
  callsServed = 0;

  next.on("message", (response: VisionResponse) => {
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (!pending.size) next.unref();
    if (response.ok) waiter.resolve(response.value);
    else waiter.reject(new Error(response.error));

    callsServed++;
    if (callsServed % REPORT_EVERY === 0) {
      console.log(`[vision] ${callsServed} 次呼叫 · 子行程 rss ${response.health.rss}MB · 最大區塊 ${response.health.largestBlockMb}MB`);
    }
    // Replaced between requests, never during one.
    const spent =
      callsServed >= MAX_CALLS ||
      response.health.largestBlockMb >= MAX_BLOCK_MB ||
      response.health.rss >= MAX_RSS_MB ||
      response.health.atCeiling;
    if (spent && pending.size === 0) {
      console.log(
        `[vision] 換一個子行程(已服務 ${callsServed} 次,rss ${response.health.rss}MB,最大區塊 ${response.health.largestBlockMb}MB${response.health.atCeiling ? ",已達上限" : ""})`,
      );
      stop();
    } else {
      armIdleExit();
    }
  });

  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    // Drop the handle so the next call starts a fresh process rather than
    // queueing onto a dead one forever.
    if (child === next) child = undefined;
  };
  next.on("error", (error) => {
    console.error(`[vision] 子行程錯誤:${error.message} · ${memoryLine()}`);
    fail(error);
  });
  next.on("exit", (code, signal) => {
    if (pending.size) {
      console.error(`[vision] 子行程在還有 ${pending.size} 個請求時結束(code ${code ?? "-"}, signal ${signal ?? "-"})`);
    }
    fail(new Error(`vision 子行程結束(code ${code ?? "-"}, signal ${signal ?? "-"})`));
  });
  return next;
}

/** End the current process; the next call starts a fresh one. */
function stop(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  const going = child;
  child = undefined;
  going?.removeAllListeners("exit");
  going?.kill();
}

function armIdleExit(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size) return armIdleExit();
    console.log(`[vision] 閒置 ${IDLE_EXIT_MS / 1000}s,收掉子行程`);
    stop();
  }, IDLE_EXIT_MS);
  idleTimer.unref?.();
}

type Job<T> = T extends { id: number } ? Omit<T, "id"> : never;

function send<T>(request: Job<VisionRequest>): Promise<T> {
  const id = nextId++;
  child ??= start();
  clearTimeout(idleTimer);
  child.ref();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    child?.send({ ...request, id } as VisionRequest, (error) => {
      if (!error) return;
      pending.delete(id);
      reject(new Error(`vision 子行程無法接收請求:${error.message}`));
    });
  });
}

/** See `ocr.recognize` — identical contract, just not in this process. */
export const recognize = (frame: Frame, region?: Region, needle?: string): Promise<OcrResult> =>
  send({ kind: "recognize", frame, region, needle });

/** See `vision.findTemplate` — identical contract, just not in this process. */
export const findTemplate = (
  frame: Frame,
  template: Uint8Array,
  region?: Region,
  threshold?: number,
): Promise<MatchResult> => send({ kind: "findTemplate", frame, template, region, threshold });

/** For /api/health: what the vision side is holding right now. */
export const visionStatus = (): { running: boolean; callsServed: number } => ({
  running: !!child,
  callsServed,
});
