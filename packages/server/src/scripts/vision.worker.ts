import { recognize } from "./ocr.js";
import { describeThrow, memoryBlocks, memoryLine } from "./vision-health.js";
import { findTemplate } from "./vision.js";
import type { Frame, Region } from "./vision.js";

/**
 * Runs the blocking half of the vision pipeline outside the server process.
 *
 * Two reasons, and they are different reasons.
 *
 * It is off the main thread because template matching is a synchronous WASM
 * call and recognition spends its time in native inference — measured 341 ms
 * for one `findTemplate` and 1295 ms for a whole-screen `recognize`. The video
 * relay lives in the server process, so on the main thread that is over a
 * second in which not one packet reaches the browser: the mirror freezes for
 * reasons that have nothing to do with the network.
 *
 * It is a separate *process* rather than a worker thread because of memory.
 * Text recognition reaches OpenCV through @gutenye/ocr-common, which keeps its
 * own 1 GiB WebAssembly heap; that heap grows with the varied crop sizes a
 * script produces and never shrinks. Measured in production: 1024 MB, at its
 * ceiling, after which every text step failed until the container was
 * restarted. A worker thread shares the process allocator, so recycling one
 * returns almost nothing (measured: 728 MB → 609 MB). Replacing a process
 * returns all of it, which is why the parent is allowed to replace this one.
 */

export type VisionRequest =
  | { id: number; kind: "recognize"; frame: Frame; region?: Region; needle?: string }
  | { id: number; kind: "findTemplate"; frame: Frame; template: Uint8Array; region?: Region; threshold?: number }
  /**
   * Several templates against one frame.
   *
   * A step that asks "which of these is on screen" could loop over
   * `findTemplate`, but each of those copies the whole ~8 MB frame across the
   * process boundary — the cost the step exists to avoid, paid again per
   * template. Sending the frame once and the templates as a list keeps it to
   * one crossing however long the list is.
   */
  | {
      id: number;
      kind: "identify";
      frame: Frame;
      cases: { template: Uint8Array; region?: Region; threshold: number }[];
    };

/** Every reply carries what the process is holding, so the parent can decide to
 * replace it without having to ask. */
export type VisionResponse = {
  id: number;
  health: { rss: number; largestBlockMb: number; atCeiling: boolean };
} & ({ ok: true; value: unknown } | { ok: false; error: string });

/** Best hit per case, in the order the cases were given. The choice of winner
 * stays with the engine — it is the one that logs the reasoning, and a policy
 * is easier to change there than behind a process boundary. */
async function identify(
  frame: Frame,
  cases: { template: Uint8Array; region?: Region; threshold: number }[],
): Promise<{ score: number; x: number; y: number }[]> {
  const out: { score: number; x: number; y: number }[] = [];
  for (const one of cases) {
    // Sequential on purpose: each match is a synchronous WASM call, so racing
    // them would only stack their allocations on the one heap that has a
    // ceiling. This process exists to keep that heap survivable.
    const match = await findTemplate(frame, one.template, one.region, one.threshold);
    out.push({ score: match.score, x: match.x, y: match.y });
  }
  return out;
}

function health(): VisionResponse["health"] {
  const blocks = memoryBlocks();
  return {
    rss: Math.round(process.memoryUsage().rss / 1048576),
    largestBlockMb: blocks[0]?.mb ?? 0,
    atCeiling: blocks.some((b) => b.atCeiling),
  };
}

process.on("message", async (request: VisionRequest) => {
  try {
    const value =
      request.kind === "recognize"
        ? await recognize(request.frame, request.region, request.needle)
        : request.kind === "identify"
          ? await identify(request.frame, request.cases)
          : await findTemplate(request.frame, request.template, request.region, request.threshold);
    process.send?.({ id: request.id, ok: true, value, health: health() } satisfies VisionResponse);
  } catch (error) {
    // Logged here as well as returned: the caller shows one line to whoever is
    // watching, and this is the copy that survives in the container log with
    // everything that was true at the time.
    const described = describeThrow(error);
    console.error(`[vision] ${request.kind} 失敗:${described} · ${memoryLine()}`);
    process.send?.({ id: request.id, ok: false, error: described, health: health() } satisfies VisionResponse);
  }
});

// The parent going away means nothing left to serve.
process.on("disconnect", () => process.exit(0));
