import { parentPort } from "node:worker_threads";
import { recognize } from "./ocr.js";
import { findTemplate } from "./vision.js";
import type { Frame, Region } from "./vision.js";

/**
 * Runs the blocking half of the vision pipeline off the main thread.
 *
 * Template matching is a synchronous WASM call and recognition spends most of
 * its time in native inference and JS post-processing, so on the main thread
 * they stop the event loop outright — measured 341 ms for one `findTemplate`
 * and 1295 ms for a whole-screen `recognize`. The video relay lives in the same
 * process, so that is over a second in which not one packet reaches the
 * browser: the mirror freezes for reasons that have nothing to do with the
 * network, which is exactly how it was first reported.
 *
 * Frames are copied in rather than transferred: the caller still needs its
 * pixels afterwards (the probe endpoints encode a preview from the same frame),
 * and a structured clone of 8 MB costs a few milliseconds against the hundreds
 * this moves away.
 */

export type VisionRequest =
  | { id: number; kind: "recognize"; frame: Frame; region?: Region; needle?: string }
  | { id: number; kind: "findTemplate"; frame: Frame; template: Uint8Array; region?: Region; threshold?: number };

export type VisionResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

parentPort?.on("message", async (request: VisionRequest) => {
  try {
    const value =
      request.kind === "recognize"
        ? await recognize(request.frame, request.region, request.needle)
        : await findTemplate(request.frame, request.template, request.region, request.threshold);
    parentPort?.postMessage({ id: request.id, ok: true, value } satisfies VisionResponse);
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies VisionResponse);
  }
});
