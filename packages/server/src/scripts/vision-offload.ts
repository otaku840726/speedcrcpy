import { Worker } from "node:worker_threads";
import type { OcrResult } from "./ocr.js";
import type { Frame, MatchResult, Region } from "./vision.js";
import type { VisionRequest, VisionResponse } from "./vision.worker.js";

/**
 * Main-thread side of the vision worker: same call signatures as the functions
 * it replaces, so callers are unaware anything moved.
 *
 * One worker, requests served in order. Vision steps are already sequential
 * within a run, and the models cost ~1.5 s to load — a pool would multiply that
 * and let two devices fight over CPU that the mirror also needs. The queue
 * makes a second device wait, which is the right trade while the alternative is
 * freezing everybody's video.
 */

/** Loading the models is slow, so the worker is started on first use and kept. */
let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  // Sibling of this module in both layouts: `src/scripts/` when run from
  // source, and the flattened `dist/` after bundling.
  const file = new URL(import.meta.url.endsWith(".ts") ? "./vision.worker.ts" : "./vision.worker.js", import.meta.url);
  worker = new Worker(file);
  worker.unref(); // never hold the process open on its account
  worker.on("message", (response: VisionResponse) => {
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.value);
    else waiter.reject(new Error(response.error));
  });
  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    // Drop the handle so the next call starts a fresh worker rather than
    // queueing onto a dead one forever.
    worker = undefined;
  };
  worker.on("error", fail);
  worker.on("exit", (code) => code !== 0 && fail(new Error(`vision worker exited with code ${code}`)));
  return worker;
}

type Job<T> = T extends { id: number } ? Omit<T, "id"> : never;

function send<T>(request: Job<VisionRequest>): Promise<T> {
  const id = nextId++;
  const target = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    target.postMessage({ ...request, id } as VisionRequest);
  });
}

/** See `ocr.recognize` — identical contract, just not on this thread. */
export const recognize = (frame: Frame, region?: Region, needle?: string): Promise<OcrResult> =>
  send({ kind: "recognize", frame, region, needle });

/** See `vision.findTemplate` — identical contract, just not on this thread. */
export const findTemplate = (
  frame: Frame,
  template: Uint8Array,
  region?: Region,
  threshold?: number,
): Promise<MatchResult> => send({ kind: "findTemplate", frame, template, region, threshold });
