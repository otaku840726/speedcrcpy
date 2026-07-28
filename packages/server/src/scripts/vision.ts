import type { Adb } from "@yume-chan/adb";
import { PNG } from "pngjs";

/**
 * Vision for automation scripts: `screencap` frames, point-colour reads, and
 * fuzzy template matching (see docs/automation-scripts.md).
 *
 * `screencap` without `-p` returns **raw RGBA** behind a small header, so point
 * colours need no image decoding at all and template matching can wrap the
 * pixels in an OpenCV Mat directly.
 */

export interface Frame {
  width: number;
  height: number;
  /** RGBA, row-major, `width * height * 4` bytes. */
  pixels: Uint8Array;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** OpenCV.js is a WASM module that initialises asynchronously; load it once. */
let cvPromise: Promise<typeof import("@techstark/opencv-js")> | undefined;

async function loadCv(): Promise<typeof import("@techstark/opencv-js")> {
  cvPromise ??= import("@techstark/opencv-js").then(async (mod) => {
    type Cv = typeof import("@techstark/opencv-js");
    const candidate = ((mod as { default?: unknown }).default ?? mod) as Partial<Cv> & {
      then?: unknown;
      onRuntimeInitialized?: () => void;
    };
    // The package's default export is a *thenable* that resolves to the
    // initialised module once the WASM runtime is up — awaiting it is the
    // supported path. (Older builds instead expose onRuntimeInitialized.)
    if (typeof candidate.then === "function") return (await candidate) as Cv;
    if (candidate.Mat) return candidate as Cv;
    return new Promise<Cv>((resolve) => {
      candidate.onRuntimeInitialized = () => resolve(candidate as Cv);
    });
  });
  return cvPromise;
}

/** Capture the current screen as raw RGBA. Throws if screencap is unusable. */
export async function capture(adb: Adb): Promise<Frame> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout, exitCode } = await shell.spawnWait("screencap");
  if (exitCode !== 0 || stdout.byteLength < 16) throw new Error("screencap failed");

  const view = new DataView(stdout.buffer, stdout.byteOffset, stdout.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (!width || !height || width > 8192 || height > 8192) throw new Error("screencap: bad dimensions");
  // Header is 12 bytes (w,h,format) or 16 (+colorSpace on newer Android).
  const headerLen = stdout.byteLength - width * height * 4;
  if (headerLen !== 12 && headerLen !== 16) throw new Error("screencap: unexpected layout");

  return { width, height, pixels: stdout.subarray(headerLen) };
}

/** Colour at a normalized (0-1) point. */
export function colorAt(frame: Frame, nx: number, ny: number): Rgb {
  const x = Math.min(frame.width - 1, Math.max(0, Math.round(nx * frame.width)));
  const y = Math.min(frame.height - 1, Math.max(0, Math.round(ny * frame.height)));
  const i = (y * frame.width + x) * 4;
  return { r: frame.pixels[i]!, g: frame.pixels[i + 1]!, b: frame.pixels[i + 2]! };
}

/** True when every channel is within `tolerance` (0-1 fraction of full scale). */
export function colorMatches(a: Rgb, b: Rgb, tolerance: number): boolean {
  const limit = Math.max(0, Math.min(1, tolerance)) * 255;
  return Math.abs(a.r - b.r) <= limit && Math.abs(a.g - b.g) <= limit && Math.abs(a.b - b.b) <= limit;
}

/** `#rrggbb` (or `rrggbb`) → Rgb. */
export function parseHex(hex: string): Rgb {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

export interface MatchResult {
  /** Best score, 0-1 (TM_CCOEFF_NORMED). */
  score: number;
  /** Centre of the best match, normalized 0-1 (only meaningful when matched). */
  x: number;
  y: number;
}

/** Search region in normalized coords; omit to search the whole frame. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Fuzzy template match. `templatePng` is a PNG (as captured by the UI's crop
 * tool); the best normalized-correlation score and the match centre come back,
 * so the caller compares against its own threshold.
 */
export async function findTemplate(frame: Frame, templatePng: Uint8Array, region?: Region): Promise<MatchResult> {
  const cv = await loadCv();

  // Frame → Mat (RGBA), optionally cropped to the search region, then RGB:
  // matching on colour is more discriminating than greyscale for UI art.
  const full = new cv.Mat(frame.height, frame.width, cv.CV_8UC4);
  full.data.set(frame.pixels);

  let searched = full;
  let offsetX = 0;
  let offsetY = 0;
  if (region) {
    const rx = Math.max(0, Math.min(frame.width - 1, Math.round(region.x * frame.width)));
    const ry = Math.max(0, Math.min(frame.height - 1, Math.round(region.y * frame.height)));
    const rw = Math.max(1, Math.min(frame.width - rx, Math.round(region.w * frame.width)));
    const rh = Math.max(1, Math.min(frame.height - ry, Math.round(region.h * frame.height)));
    searched = full.roi(new cv.Rect(rx, ry, rw, rh));
    offsetX = rx;
    offsetY = ry;
  }

  const haystack = new cv.Mat();
  cv.cvtColor(searched, haystack, cv.COLOR_RGBA2RGB);

  // This OpenCV build ships without imgcodecs (imdecode/imencode are absent;
  // imread needs a browser canvas), so decode the template PNG in pure JS.
  const png = PNG.sync.read(Buffer.from(templatePng));
  const templateRgba = new cv.Mat(png.height, png.width, cv.CV_8UC4);
  templateRgba.data.set(png.data);
  const needle = new cv.Mat();
  cv.cvtColor(templateRgba, needle, cv.COLOR_RGBA2RGB);

  const cleanup = () => {
    if (searched !== full) searched.delete();
    full.delete();
    haystack.delete();
    templateRgba.delete();
    needle.delete();
  };

  if (needle.rows === 0 || needle.cols === 0) {
    cleanup();
    throw new Error("template could not be decoded");
  }
  if (needle.rows > haystack.rows || needle.cols > haystack.cols) {
    cleanup();
    throw new Error("template is larger than the search area");
  }

  const result = new cv.Mat();
  cv.matchTemplate(haystack, needle, result, cv.TM_CCOEFF_NORMED);
  // The mask argument is optional at runtime but required by the typings.
  const noMask = new cv.Mat();
  const { maxVal, maxLoc } = cv.minMaxLoc(result, noMask);
  noMask.delete();
  const centreX = offsetX + maxLoc.x + needle.cols / 2;
  const centreY = offsetY + maxLoc.y + needle.rows / 2;
  result.delete();
  cleanup();

  return { score: maxVal, x: centreX / frame.width, y: centreY / frame.height };
}
