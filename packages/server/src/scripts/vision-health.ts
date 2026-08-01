import { readFileSync } from "node:fs";

/**
 * What the vision process is holding, and what to say when it runs out.
 *
 * Both halves exist because of one failure: after hours of script runs, every
 * text step began failing with `錯誤:1068720816` and nothing else — no stack,
 * no log line, no clue. That number was an exception *pointer*, and where it
 * pointed turned out to be the whole diagnosis: 0.995 GiB, just inside a
 * 1024 MiB block. See `describeThrow` for what it means.
 */

/** One contiguous read/write mapping — a WASM heap is exactly this. */
export interface MemoryBlock {
  mb: number;
  /** An Emscripten heap that has grown to its build-time maximum cannot serve
   * another byte, and cannot shrink. Worth calling out by name. */
  atCeiling: boolean;
}

/** Emscripten's default MAXIMUM_MEMORY, and the size of the block that filled. */
const WASM_CEILING_MB = 1024;

/**
 * The big anonymous mappings of this process, largest first.
 *
 * Read from /proc, so Linux only — which is where this runs in production. On
 * anything else the caller gets an empty list and falls back to `rss`.
 */
export function memoryBlocks(): MemoryBlock[] {
  try {
    const blocks: MemoryBlock[] = [];
    for (const line of readFileSync("/proc/self/maps", "utf8").split("\n")) {
      const [range, perms] = line.split(" ");
      if (!range || !perms?.startsWith("rw")) continue;
      const [lo, hi] = range.split("-");
      if (!lo || !hi) continue;
      const mb = Math.round((Number.parseInt(hi, 16) - Number.parseInt(lo, 16)) / 1048576);
      if (mb >= 64) blocks.push({ mb, atCeiling: mb >= WASM_CEILING_MB });
    }
    return blocks.sort((a, b) => b.mb - a.mb).slice(0, 5);
  } catch {
    return [];
  }
}

/** One line for a log or a health payload. */
export function memoryLine(): string {
  const { rss, external } = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  const blocks = memoryBlocks();
  const shape = blocks.length ? ` · 區塊 ${blocks.map((b) => `${b.mb}${b.atCeiling ? "(滿)" : ""}`).join("/")} MB` : "";
  return `rss ${mb(rss)}MB · external ${mb(external)}MB${shape}`;
}

/**
 * Turn whatever was thrown into something a person can act on.
 *
 * A number is not a code — it is a pointer into a WebAssembly heap, which is
 * how Emscripten reports a C++ exception it could not convert. The text
 * recogniser reaches OpenCV through @gutenye/ocr-common, on its own 1 GiB
 * heap, separate from the one template matching uses; when that heap fills,
 * every text step fails while image steps keep working, and it stays that way
 * until the process is replaced, because a WASM heap never shrinks.
 */
export function describeThrow(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "number") return String(error);
  const full = memoryBlocks().find((b) => b.atCeiling);
  return full
    ? `文字辨識的記憶體已滿:WASM 區塊 ${full.mb} MB 已達上限(原生例外 #${error})— ${memoryLine()}`
    : `原生層例外 #${error}(通常是記憶體不足)— ${memoryLine()}`;
}
