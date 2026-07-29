import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptTextKey, scriptTextMatches } from "@speedcrcpy/shared";
import { PNG } from "pngjs";
import { readingOrder } from "./vision.js";
import type { Frame, Region } from "./vision.js";

/**
 * Text recognition for automation scripts (PP-OCRv6-small via ONNX).
 *
 * Chosen over Tesseract after measuring both on a real game screen: Tesseract
 * read a 4-character button as 3/4 characters however it was preprocessed,
 * while PP-OCR read it exactly. Tesseract also needed contrast normalisation
 * to work at all on dark, low-contrast game art; PP-OCR does not.
 *
 * The models come from `scripts/fetch-ocr-models.mjs` rather than the ones
 * `@gutenye/ocr-node` bundles, because those are PP-OCRv4 with a
 * simplified-only dictionary that cannot represent most everyday traditional
 * characters — measured on a real screen, 遊戲 came back as 游 and 闖關大挑戰
 * as 關大挑. v6 reads both correctly, for about 35% more time per region
 * (34 ms → 46 ms), which is noise next to the ~350 ms the screencap costs.
 *
 * **Always prefer a region.** Whole-screen recognition takes ~1.7 s and merges
 * everything on one horizontal line into a single result whose box spans the
 * screen — useless for tapping. A cropped region is ~50 ms and gives a tight,
 * tappable box.
 */

const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "models");

export interface OcrLine {
  text: string;
  /** Match centre in normalized (0-1) device coordinates. */
  x: number;
  y: number;
  /** Bounding box in normalized device coordinates, so a UI can outline it. */
  w: number;
  h: number;
  /** Recognition confidence, 0-1. */
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  /** All recognised text joined, for substring tests. */
  text: string;
  ms: number;
  /**
   * Every place the requested text was found, in **reading order** (top to
   * bottom, then left to right), each narrowed to the words themselves rather
   * than the line they sit on — see `refine`. Empty when the caller didn't ask
   * about any particular text, or nothing matched.
   */
  matches: OcrLine[];
  /** The match `occurrence` selected, i.e. where a tap would land. */
  tap: OcrLine | null;
}

export interface RecognizeOptions {
  /** Text to locate; without it there is nothing to narrow down and `matches`
   * comes back empty. */
  needle?: string;
  /** Which match to aim at, in reading order. Out of range yields no `tap`. */
  occurrence?: number;
}

/** A box in frame pixels, the unit everything internal works in. */
interface PixelLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

/** Upscale crops shorter than this, so the recogniser has pixels to work with. */
const MIN_LINE_PX = 64;
const MAX_SCALE = 4;
/** How many times `refine` may split before settling for what it has. */
const REFINE_MAX_DEPTH = 5;
/**
 * Ceiling on narrowing passes **per matching line**, not per call.
 *
 * A shared pool would couple the lines to each other: spend it on the first few
 * and the last ones come back as whole bands, so how many occurrences a screen
 * appears to have would depend on how many other lines happened to match. A
 * saved `occurrence: 3` has to keep meaning the same thing, so each line gets
 * its own allowance and is enumerated identically however busy the screen is.
 */
const REFINE_CALLS_PER_LINE = 16;
/** Lines narrowed at all, in reading order; the rest keep their band box. A
 * framed region never gets near this — whole-screen search on a common word
 * does, which is the case the region advice exists for. */
const REFINE_MAX_LINES = 8;
/**
 * Halves overlap by this fraction, so a word sitting on the seam survives whole
 * in one side. When it doesn't, both halves report a partial box and the same
 * word is counted twice — which is why the per-line allowance has to be enough
 * to keep splitting until the two views converge and dedupe merges them.
 */
const SPLIT_OVERLAP = 0.15;

type ModelPaths = { detectionPath: string; recognitionPath: string; dictionaryPath: string };
type Detector = { detect(path: string): Promise<{ text: string; mean: number; box: number[][] }[]> };
type OcrModule = { create(options?: { models: ModelPaths }): Promise<Detector> };

let ocrPromise: Promise<Detector> | undefined;

/**
 * The fetched PP-OCRv6 weights, or undefined when the postinstall download
 * didn't run (offline dev) — in which case the bundled v4 still gives a working
 * server, just one that misreads traditional Chinese.
 */
function fetchedModels(): ModelPaths | undefined {
  const paths = {
    detectionPath: join(MODELS_DIR, "det.onnx"),
    recognitionPath: join(MODELS_DIR, "rec.onnx"),
    dictionaryPath: join(MODELS_DIR, "dict.txt"),
  };
  return Object.values(paths).every(existsSync) ? paths : undefined;
}

/** Load the models once; they cost ~1.5 s and are reused for every call. */
async function loadOcr(): Promise<Detector> {
  ocrPromise ??= import("@gutenye/ocr-node").then(async (mod) => {
    const Ocr = (mod as { default?: OcrModule }).default ?? (mod as unknown as OcrModule);
    const models = fetchedModels();
    if (!models) {
      console.warn("[ocr] PP-OCRv6 weights missing — falling back to the bundled PP-OCRv4 (traditional Chinese will be misread)");
      console.warn("[ocr] run `node scripts/fetch-ocr-models.mjs` in packages/server to fix");
    }
    return Ocr.create(models ? { models } : undefined);
  });
  return ocrPromise;
}

/** Clamp a pixel rect to the frame. */
function clampRect(frame: Frame, r: { x: number; y: number; w: number; h: number }) {
  const x = Math.max(0, Math.min(frame.width - 1, Math.round(r.x)));
  const y = Math.max(0, Math.min(frame.height - 1, Math.round(r.y)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(frame.width - x, Math.round(r.w))),
    h: Math.max(1, Math.min(frame.height - y, Math.round(r.h))),
  };
}

/** Crop a pixel rect to a PNG, scaling up so short crops stay legible. */
function cropPng(frame: Frame, r: { x: number; y: number; w: number; h: number }, scale: number): Buffer {
  const png = new PNG({ width: r.w * scale, height: r.h * scale });
  if (scale === 1) {
    // Whole-frame passes go through here; copying by row beats per-pixel by far.
    for (let row = 0; row < r.h; row++) {
      const src = ((r.y + row) * frame.width + r.x) * 4;
      png.data.set(frame.pixels.subarray(src, src + r.w * 4), row * r.w * 4);
    }
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    return PNG.sync.write(png);
  }
  for (let row = 0; row < png.height; row++) {
    const srcRow = (r.y + Math.floor(row / scale)) * frame.width;
    for (let col = 0; col < png.width; col++) {
      const src = (srcRow + r.x + Math.floor(col / scale)) * 4;
      const dst = (row * png.width + col) * 4;
      png.data[dst] = frame.pixels[src]!;
      png.data[dst + 1] = frame.pixels[src + 1]!;
      png.data[dst + 2] = frame.pixels[src + 2]!;
      // screencap alpha is meaningful only sometimes; force opaque so the PNG is stable.
      png.data[dst + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** One recognition pass over a pixel rect; boxes come back in frame pixels. */
async function detect(frame: Frame, rect: { x: number; y: number; w: number; h: number }, dir: string, seq: number): Promise<PixelLine[]> {
  const ocr = await loadOcr();
  const r = clampRect(frame, rect);
  const scale = Math.max(1, Math.min(MAX_SCALE, Math.ceil(MIN_LINE_PX / r.h)));
  const file = join(dir, `crop-${seq}.png`);
  writeFileSync(file, cropPng(frame, r, scale));
  const raw = await ocr.detect(file);
  return raw.map((line) => {
    const xs = line.box.map((p) => p[0]!);
    const ys = line.box.map((p) => p[1]!);
    return {
      text: line.text,
      x: r.x + (Math.min(...xs) + Math.max(...xs)) / 2 / scale,
      y: r.y + (Math.min(...ys) + Math.max(...ys)) / 2 / scale,
      w: (Math.max(...xs) - Math.min(...xs)) / scale,
      h: (Math.max(...ys) - Math.min(...ys)) / scale,
      confidence: line.mean,
    };
  });
}

const pickHit = (lines: PixelLine[], needle: string): PixelLine | undefined =>
  // Narrowest first: inside `refine` that is the convergence criterion, and the
  // x tiebreak keeps the choice deterministic when two candidates tie.
  lines.filter((l) => scriptTextMatches(l.text, needle)).sort((a, b) => a.w - b.w || a.x - b.x)[0];

/** Compare in the same normalized form the matcher uses, so "the box *is*
 * the needle" agrees with "the box contains the needle". */
const stripped = scriptTextKey;

/** Two boxes covering mostly the same span are one occurrence seen twice. */
function sameSpan(a: PixelLine, b: PixelLine): boolean {
  const lo = Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const hi = Math.min(a.x + a.w / 2, b.x + b.w / 2);
  return hi - lo > 0.5 * Math.min(a.w, b.w);
}

/**
 * Narrow a recognised band down to the words that matched, so a tap lands on
 * them — and find *every* occurrence in that band, not just one.
 *
 * A recognised "line" is a whole horizontal band: an app icon, a rating and a
 * label routinely share one box, and a row of cards can put the same button
 * label in it three times. So the line's centre often sits on something other
 * than the text that was asked for. Estimating the substring's position from
 * character widths fails exactly where it matters — the band's width includes
 * non-text pixels that no character accounts for, which put the estimate 28 px
 * outside the target word on a line with a leading icon.
 *
 * So measure rather than estimate: split the band in half (overlapping, so a
 * word sitting on the seam still lands whole in one side), recognise each half,
 * and recurse into whichever halves still contain the needle. Splitting into
 * *both* halves rather than the better one is what turns this from "find the
 * match" into "find all the matches".
 *
 * Splits are horizontal only, and always measured against the original band:
 * re-cropping the vertical extent each round shaves off ascenders and
 * descenders until the text stops being recognisable.
 */
async function refine(
  frame: Frame,
  line: PixelLine,
  needle: string,
  dir: string,
  seq: { n: number },
): Promise<PixelLine[]> {
  const pad = line.h * 0.25;
  const band = { y: line.y - line.h / 2 - pad, h: line.h + pad * 2 };
  const found: PixelLine[] = [];
  const budget = { calls: REFINE_CALLS_PER_LINE };

  const walk = async (hit: PixelLine, depth: number): Promise<void> => {
    const width = hit.w;
    if (stripped(hit.text) === stripped(needle) || depth >= REFINE_MAX_DEPTH || width <= line.h) {
      found.push(hit); // the box is the needle, or there is no room left to split
      return;
    }
    const half = width / 2 + width * SPLIT_OVERLAP;
    const left = hit.x - width / 2;
    const next: PixelLine[] = [];
    for (const x of [left, left + width - half]) {
      if (budget.calls <= 0) break;
      budget.calls -= 1;
      const sub = pickHit(await detect(frame, { ...band, x, w: half }, dir, seq.n++), needle);
      if (sub && sub.w < width) next.push(sub);
    }
    if (!next.length) {
      found.push(hit); // no progress — what we already have is the best answer
      return;
    }
    // The halves overlap on purpose, so one occurrence can surface in both.
    const distinct = next.length === 2 && sameSpan(next[0]!, next[1]!) ? [next[0]!.w <= next[1]!.w ? next[0]! : next[1]!] : next;
    for (const sub of distinct) await walk(sub, depth + 1);
  };

  await walk(line, 0);
  // Take only the horizontal extent from the narrowing passes. Re-detecting
  // inside the padded band gives a vertical box biased low — measured 7-17 px
  // down on a 46-55 px line, enough to drop the tap onto the bottom edge of the
  // glyphs. The band's own y came from the full, unclipped line, so it is both
  // more accurate and the thing this function never set out to change.
  const flat = found.map((box) => ({ ...box, y: line.y, h: line.h }));
  // Separate branches can still converge on the same words.
  const unique: PixelLine[] = [];
  for (const box of flat.sort((a, b) => a.x - b.x)) {
    if (!unique.some((u) => sameSpan(u, box))) unique.push(box);
  }
  return unique;
}

/**
 * Recognise text in `region` (normalized) of `frame`. Boxes come back in
 * normalized device coordinates, so a caller can tap a match directly.
 *
 * Pass `needle` to also get `matches` — every place that text appears, in
 * reading order, each narrowed to the words themselves — and `tap`, the one
 * `occurrence` selects.
 */
export async function recognize(frame: Frame, region?: Region, options: RecognizeOptions = {}): Promise<OcrResult> {
  const started = Date.now();
  const { needle, occurrence = 0 } = options;
  const rect = region
    ? { x: region.x * frame.width, y: region.y * frame.height, w: region.w * frame.width, h: region.h * frame.height }
    : { x: 0, y: 0, w: frame.width, h: frame.height };

  const dir = mkdtempSync(join(tmpdir(), "speedcrcpy-ocr-"));
  try {
    const raw = await detect(frame, rect, dir, 0);
    const normalize = (l: PixelLine): OcrLine => ({
      text: l.text,
      x: l.x / frame.width,
      y: l.y / frame.height,
      w: l.w / frame.width,
      h: l.h / frame.height,
      confidence: l.confidence,
    });

    const matches: PixelLine[] = [];
    if (needle) {
      const seq = { n: 1 };
      const bands = readingOrder(raw.filter((l) => scriptTextMatches(l.text, needle)));
      for (const [index, band] of bands.entries()) {
        // Past the cap, report the band itself rather than spending minutes on
        // a screen that should have been searched with a region.
        matches.push(...(index < REFINE_MAX_LINES ? await refine(frame, band, needle, dir, seq) : [band]));
      }
    }

    const ordered = readingOrder(matches).map(normalize);
    const lines = raw.map(normalize);
    return {
      lines,
      text: lines.map((l) => l.text).join(" "),
      ms: Date.now() - started,
      matches: ordered,
      tap: ordered[occurrence] ?? null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whitespace-insensitive containment (shared with the editor so they agree). */
export const textMatches = scriptTextMatches;

/** First number in the text (handles thousands separators and decimals). */
export function parseNumber(text: string): number | null {
  const m = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
