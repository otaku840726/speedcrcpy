import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Frame, Region } from "./vision.js";

/**
 * Text recognition for automation scripts (PP-OCRv4 via ONNX).
 *
 * Chosen over Tesseract after measuring both on a real game screen: Tesseract
 * read a 4-character button as 3/4 characters however it was preprocessed,
 * while PP-OCR read it exactly. Tesseract also needed contrast normalisation
 * to work at all on dark, low-contrast game art; PP-OCR does not.
 *
 * **Always prefer a region.** Whole-screen recognition takes ~1.5 s and merges
 * everything on one horizontal line into a single result whose box spans the
 * screen — useless for tapping. A cropped region is ~50 ms and gives a tight,
 * tappable box.
 */

export interface OcrLine {
  text: string;
  /** Match centre in normalized (0-1) device coordinates. */
  x: number;
  y: number;
  /** Recognition confidence, 0-1. */
  confidence: number;
}

export interface OcrResult {
  lines: OcrLine[];
  /** All recognised text joined, for substring tests. */
  text: string;
  ms: number;
}

type Detector = { detect(path: string): Promise<{ text: string; mean: number; box: number[][] }[]> };

let ocrPromise: Promise<Detector> | undefined;

/** Load the models once; they cost ~1.5 s and are reused for every call. */
async function loadOcr(): Promise<Detector> {
  ocrPromise ??= import("@gutenye/ocr-node").then(async (mod) => {
    const Ocr = (mod as { default?: { create(): Promise<Detector> } }).default ?? (mod as unknown as { create(): Promise<Detector> });
    return Ocr.create();
  });
  return ocrPromise;
}

/** Crop a frame region (or the whole frame) to a PNG buffer. */
function cropPng(frame: Frame, region?: Region): { png: Buffer; x: number; y: number; w: number; h: number } {
  const x = region ? Math.max(0, Math.min(frame.width - 1, Math.round(region.x * frame.width))) : 0;
  const y = region ? Math.max(0, Math.min(frame.height - 1, Math.round(region.y * frame.height))) : 0;
  const w = region ? Math.max(1, Math.min(frame.width - x, Math.round(region.w * frame.width))) : frame.width;
  const h = region ? Math.max(1, Math.min(frame.height - y, Math.round(region.h * frame.height))) : frame.height;

  const png = new PNG({ width: w, height: h });
  for (let r = 0; r < h; r++) {
    const src = ((y + r) * frame.width + x) * 4;
    png.data.set(frame.pixels.subarray(src, src + w * 4), r * w * 4);
  }
  // screencap alpha is meaningful only sometimes; force opaque so the PNG is stable.
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return { png: PNG.sync.write(png), x, y, w, h };
}

/**
 * Recognise text in `region` (normalized) of `frame`. Boxes come back in
 * normalized device coordinates, so a caller can tap a match directly.
 */
export async function recognize(frame: Frame, region?: Region): Promise<OcrResult> {
  const ocr = await loadOcr();
  const started = Date.now();
  const { png, x, y, w, h } = cropPng(frame, region);

  const dir = mkdtempSync(join(tmpdir(), "speedcrcpy-ocr-"));
  const file = join(dir, "region.png");
  try {
    writeFileSync(file, png);
    const raw = await ocr.detect(file);
    const lines: OcrLine[] = raw.map((line) => {
      const xs = line.box.map((p) => p[0]!);
      const ys = line.box.map((p) => p[1]!);
      const cx = x + (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = y + (Math.min(...ys) + Math.max(...ys)) / 2;
      return {
        text: line.text,
        x: cx / frame.width,
        y: cy / frame.height,
        confidence: line.mean,
      };
    });
    return { lines, text: lines.map((l) => l.text).join(" "), ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whitespace-insensitive containment, the way a script author means it. */
export function textMatches(haystack: string, needle: string): boolean {
  const strip = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  return strip(haystack).includes(strip(needle));
}

/** First number in the text (handles thousands separators and decimals). */
export function parseNumber(text: string): number | null {
  const m = text.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
