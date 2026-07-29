import { foldHan } from "./han-fold.js";

/**
 * Automation script model (see docs/automation-scripts.md).
 *
 * Scripts run server-side over plain adb (screencap for vision, `input` for
 * actions), independent of any viewer session. All coordinates are
 * **normalized 0-1** against the device's logical display, so a script keeps
 * working across resolution overrides and rotation.
 */

/** Hardware/navigation keys a script can press. */
export type ScriptKey = "back" | "home" | "recents" | "power" | "wake" | "volumeUp" | "volumeDown";

/** Search area for image matching, normalized 0-1; omit to search everything. */
export interface ScriptRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A captured image to look for. `png` is base64 (no data: prefix). */
export interface ScriptTemplate {
  png: string;
  /** Logical display size the template was captured at — matching is not
   * scale-invariant, so a mismatch here is worth warning about. */
  capturedWidth: number;
  capturedHeight: number;
}

export type ScriptStep =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  /** Fixed delay when min === max, otherwise a uniform random delay in between. */
  | { type: "wait"; minMs: number; maxMs: number }
  | { type: "text"; value: string }
  | { type: "key"; key: ScriptKey }
  /** `count` <= 0 means loop forever (until stopped or preempted). */
  | { type: "loop"; count: number; body: ScriptStep[] }
  /** Poll until the pixel matches `color` (#rrggbb) within `tolerance` (0-1). */
  | { type: "waitColor"; x: number; y: number; color: string; tolerance: number; timeoutMs: number }
  /** Branch on the current colour at a point. */
  | {
      type: "ifColor";
      x: number;
      y: number;
      color: string;
      tolerance: number;
      then: ScriptStep[];
      else?: ScriptStep[];
    }
  /** Poll until the template is found (score >= threshold), then tap its centre. */
  | {
      type: "findTap";
      template: ScriptTemplate;
      threshold: number;
      timeoutMs: number;
      region?: ScriptRegion;
      /** Optional tap offset from the match centre, normalized. */
      offsetX?: number;
      offsetY?: number;
      /** Which candidates count, and which of them to tap. */
      filter?: ScriptFilter;
      pick?: ScriptPick;
    }
  /** Branch on whether the template is on screen right now. */
  | {
      type: "ifImage";
      template: ScriptTemplate;
      threshold: number;
      region?: ScriptRegion;
      then: ScriptStep[];
      else?: ScriptStep[];
    }
  /**
   * Recognise text and tap what matched. Matching is substring-based
   * (whitespace-insensitive) because OCR drops or alters the odd character on
   * stylised game fonts — search for a distinctive fragment, not the full label.
   * A region is strongly recommended: whole-screen OCR is ~30x slower and its
   * boxes span the whole line, which makes the tap point useless.
   */
  | {
      type: "tapText";
      text: string;
      region?: ScriptRegion;
      timeoutMs: number;
      /** Which candidates count, and which of them to tap. */
      filter?: ScriptFilter;
      pick?: ScriptPick;
    }
  /** Branch on whether recognised text contains `text`. */
  | { type: "ifText"; text: string; region?: ScriptRegion; then: ScriptStep[]; else?: ScriptStep[] }
  /** Read the first number in the region and compare it. */
  | {
      type: "ifNumber";
      region?: ScriptRegion;
      compare: ">" | ">=" | "<" | "<=" | "==";
      value: number;
      then: ScriptStep[];
      else?: ScriptStep[];
    };

/**
 * When a script wants to run. `persistent` keeps it running whenever nothing
 * higher-priority is active; `daily` activates once a day at `time` and
 * deactivates when that run finishes; `manual` only runs on demand.
 */
export type ScriptTrigger =
  | { type: "manual" }
  | { type: "persistent" }
  | { type: "daily"; time: string };

export const PRIORITY_LABELS: { value: number; label: string }[] = [
  { value: 30, label: "高" },
  { value: 20, label: "中" },
  { value: 10, label: "低" },
];

export interface Script {
  id: string;
  deviceSerial: string;
  name: string;
  steps: ScriptStep[];
  trigger: ScriptTrigger;
  /** Higher wins when two scripts want the same device. */
  priority: number;
  /** Scheduling opt-out; a disabled script only runs when started by hand. */
  enabled: boolean;
}

export type ScriptRunState = "idle" | "running" | "stopping";

export interface ScriptLogEntry {
  /** Epoch ms. */
  at: number;
  message: string;
}

/** Why a script that wants the device isn't running yet. */
export type ScriptPendingReason =
  /** Waiting its turn (starting, or the device is briefly busy). */
  | "queued"
  /** Held off because someone is touching the device. */
  | "humanActive"
  /** Another, higher-priority script has the device. */
  | "outranked";

export interface ScriptStatus {
  serial: string;
  scriptId: string | null;
  scriptName: string | null;
  state: ScriptRunState;
  /** Steps executed since this run started. */
  stepsRun: number;
  startedAt: number | null;
  log: ScriptLogEntry[];
  /** Set while a script is queued for this device but not yet running, so the
   * UI can explain the wait instead of looking unresponsive. */
  pending: { scriptId: string; scriptName: string; reason: ScriptPendingReason } | null;
}

// ---- scheduling overview (REST: GET /api/schedule) ----

export interface ScheduleScript {
  id: string;
  name: string;
  trigger: ScriptTrigger;
  priority: number;
  enabled: boolean;
  /** running = on the device now; waiting = wants the device but outranked or
   * paused; idle = not currently asking for the device. */
  state: "running" | "waiting" | "idle";
  /** Epoch ms of the next daily activation, when known. */
  nextRunAt: number | null;
}

export interface DeviceSchedule {
  serial: string;
  /** True while recent manual input is holding scripts off the device. */
  humanActive: boolean;
  scripts: ScheduleScript[];
}

// ---- text matching helpers (shared so the engine and the editor agree) ----

/**
 * The form two pieces of text are compared in: no whitespace, lower case, one
 * Han variant. OCR drops and inserts spaces freely, and flips 裝/装 depending
 * on the crop it saw, so none of those differences may decide a match.
 */
export function scriptTextKey(text: string): string {
  return foldHan(text).replace(/\s+/g, "").toLowerCase();
}

/** Whitespace- and variant-insensitive containment, the way an author means it. */
export function scriptTextMatches(haystack: string, needle: string): boolean {
  return scriptTextKey(haystack).includes(scriptTextKey(needle));
}

// ---- candidate filtering and selection (shared, so preview and engine agree) ----

/**
 * How the searched text must sit inside what was recognised.
 *
 * `contains` is the default because OCR drops and alters characters on
 * stylised fonts, so authors search for a distinctive fragment. But a fragment
 * matches too much — searching 領取 also hits 已領取 and 領取獎勵 — so an
 * author who knows the label stands alone can say so.
 */
export type ScriptTextMode =
  /** Substring, anywhere. */
  | "contains"
  /** A whole whitespace-separated token of the recognised line. */
  | "standalone"
  /** The entire recognised line. */
  | "exact";

/** Which candidates count. Applied before anything is chosen between them. */
export interface ScriptFilter {
  mode?: ScriptTextMode;
  /** Drop reads below this confidence (0-1). OCR junk scores low. */
  minConfidence?: number;
}

/**
 * How to order candidates before taking one. `reading` is top to bottom, then
 * left to right within a row — the order a person would count them in.
 */
export type ScriptPickBy =
  | "reading"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "score"
  | "random"
  | "nearest"
  | "farthest";

export interface ScriptPick {
  by?: ScriptPickBy;
  /**
   * Where `nearest`/`farthest` measure from, normalized. Defaults to the centre
   * of the screen, which is where a camera-locked game keeps the player — so
   * "the monster closest to my character" is usually the default plus nothing.
   *
   * A fixed point only works while the thing you measure from stays put on
   * screen. Measuring from something that moves needs a step that locates it
   * first and remembers where it was; these two fields stay as they are when
   * that lands, with the source becoming a third option.
   */
  refX?: number;
  refY?: number;
  /** Which one after ordering. */
  index?: number;
  /** `one` means several matches are a misread — wait rather than guess. */
  expect?: "any" | "one";
}

/** The frame candidates were found in. Only distance ordering needs it: a
 * normalized unit is not the same length across and down a 1080x1920 screen,
 * so measuring in normalized space would rank a box 100 px below the reference
 * as closer than one 150 px to the side. */
export interface ScriptFrameSize {
  width: number;
  height: number;
}

/** Anything a step can act on: a recognised phrase or a template match. */
export interface ScriptCandidate {
  /** Centre and size, normalized 0-1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** OCR confidence or template score, 0-1. */
  confidence: number;
  /** The matched words (text steps only). */
  text?: string;
  /** The whole recognised band the match sits in — what `mode` is judged on,
   * since the match itself has already been narrowed down to the words. */
  lineText?: string;
}

/** Why a candidate was dropped. The preview shows this; a filter that removes
 * things silently is impossible to debug. */
export type ScriptRejectReason = "mode" | "confidence";

export interface ScriptSelection<T extends ScriptCandidate> {
  /** Survivors, in pick order. */
  kept: T[];
  rejected: { candidate: T; reason: ScriptRejectReason }[];
  /** What the step acts on — null when nothing qualifies. */
  chosen: T | null;
  /** True when `expect: "one"` wasn't satisfied. A polling step should keep
   * waiting rather than act: a transition frame often shows two of something
   * for a frame or two before settling. */
  unsettled: boolean;
}

/** True when `needle` sits inside `line` the way `mode` requires. */
export function scriptTextMatchesMode(line: string, needle: string, mode: ScriptTextMode = "contains"): boolean {
  const want = scriptTextKey(needle);
  if (!want) return false;
  if (mode === "contains") return scriptTextKey(line).includes(want);
  if (mode === "exact") return scriptTextKey(line) === want;
  // standalone: a whole whitespace-separated token, or the whole line. When OCR
  // drops the spaces the line is one token, so this degrades to `exact` —
  // conservative, which is the right direction for "nothing around it".
  return line.split(/\s+/).some((token) => scriptTextKey(token) === want);
}

const byX = (a: ScriptCandidate, b: ScriptCandidate) => a.x - b.x;
const byY = (a: ScriptCandidate, b: ScriptCandidate) => a.y - b.y;

/** Squared distance from a candidate to the reference, in frame pixels. */
function distance2(c: ScriptCandidate, pick: ScriptPick, frame: ScriptFrameSize): number {
  const dx = (c.x - (pick.refX ?? 0.5)) * frame.width;
  const dy = (c.y - (pick.refY ?? 0.5)) * frame.height;
  return dx * dx + dy * dy;
}

/** Reading order: top to bottom, then left to right within a row. Two boxes
 * share a row when their vertical centres are within half a box height. */
export function scriptReadingOrder<T extends ScriptCandidate>(boxes: T[]): T[] {
  const rows: T[][] = [];
  for (const box of [...boxes].sort(byY)) {
    const row = rows[rows.length - 1];
    const head = row?.[0];
    if (row && head && Math.abs(box.y - head.y) < Math.min(box.h, head.h) * 0.6) row.push(box);
    else rows.push([box]);
  }
  return rows.flatMap((row) => row.sort(byX));
}

function order<T extends ScriptCandidate>(kept: T[], pick: ScriptPick, frame: ScriptFrameSize): T[] {
  const by = pick.by ?? "reading";
  switch (by) {
    case "nearest":
    case "farthest": {
      const sign = by === "nearest" ? 1 : -1;
      // Reading order breaks ties, so two equidistant candidates keep a stable
      // order instead of depending on how the sort happened to run.
      return scriptReadingOrder(kept).sort((a, b) => sign * (distance2(a, pick, frame) - distance2(b, pick, frame)));
    }
    case "left":
      return [...kept].sort(byX);
    case "right":
      return [...kept].sort((a, b) => b.x - a.x);
    case "top":
      return [...kept].sort(byY);
    case "bottom":
      return [...kept].sort((a, b) => b.y - a.y);
    case "score":
      return [...kept].sort((a, b) => b.confidence - a.confidence);
    case "random": {
      // Reading order first so the shuffle is over a defined sequence; the
      // engine logs which index came up, or a surprise is unexplainable.
      const pool = scriptReadingOrder(kept);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      return pool;
    }
    default:
      return scriptReadingOrder(kept);
  }
}

/**
 * Filter candidates, order them, and take one — the whole "which of these did
 * you mean" decision in one place so the editor's preview and the engine can
 * never disagree about it.
 */
export function scriptSelect<T extends ScriptCandidate>(
  candidates: T[],
  needle: string | undefined,
  filter: ScriptFilter = {},
  pick: ScriptPick = {},
  frame: ScriptFrameSize = { width: 1, height: 1 },
): ScriptSelection<T> {
  const rejected: { candidate: T; reason: ScriptRejectReason }[] = [];
  const kept: T[] = [];
  for (const candidate of candidates) {
    if (needle && candidate.lineText !== undefined && !scriptTextMatchesMode(candidate.lineText, needle, filter.mode)) {
      rejected.push({ candidate, reason: "mode" });
    } else if (filter.minConfidence != null && candidate.confidence < filter.minConfidence) {
      rejected.push({ candidate, reason: "confidence" });
    } else {
      kept.push(candidate);
    }
  }

  const ordered = order(kept, pick, frame);
  const unsettled = pick.expect === "one" && ordered.length !== 1;
  return {
    kept: ordered,
    rejected,
    chosen: unsettled ? null : (ordered[pick.index ?? 0] ?? null),
    unsettled,
  };
}

/**
 * Scripts saved before filter/pick existed carry a bare `occurrence`; fold it
 * into `pick.index` so an existing script keeps aiming where it did. Applied on load and on
 * save, and kept out of the zod schema because a discriminated union cannot
 * hold transformed members.
 */
export function scriptMigrateSteps(steps: ScriptStep[]): ScriptStep[] {
  return steps.map((step) => {
    const legacy = step as ScriptStep & { occurrence?: number };
    let next = step;
    if (legacy.occurrence != null && (step.type === "tapText" || step.type === "findTap")) {
      const { occurrence, ...rest } = legacy;
      next = { ...rest, pick: { ...step.pick, index: step.pick?.index ?? occurrence } } as ScriptStep;
    }
    if (next.type === "loop") return { ...next, body: scriptMigrateSteps(next.body) };
    if ("then" in next && next.then) {
      return { ...next, then: scriptMigrateSteps(next.then), ...(next.else ? { else: scriptMigrateSteps(next.else) } : {}) } as ScriptStep;
    }
    return next;
  });
}
