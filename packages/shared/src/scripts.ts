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

/**
 * Ceiling on one template's base64 PNG, shared so the editor refuses the same
 * crop the server would.
 *
 * Generous on purpose: a marquee is cropped at full device resolution and
 * cannot be downscaled to fit (matching is not scale-invariant, so a shrunken
 * template stops matching the screen it is searched against), so a legitimate
 * selection over a third of a 1080×2400 screen already runs to a couple of MB
 * once base64 adds its 4/3. Past this it is a mis-drag, not a template.
 */
export const MAX_TEMPLATE_BASE64 = 4_000_000;

/**
 * A step, plus the switch every step carries.
 *
 * `disabled` keeps a step in the script but out of the run. The settings that
 * take longest to get right — a framed template, a tuned threshold, a picked
 * region — are exactly what deleting a step throws away, so trying a script
 * without one step has to be possible without losing it. A disabled loop or
 * if-step takes everything nested inside it out of the run too.
 */
export type ScriptStep = ScriptStepKind & {
  disabled?: boolean;
  /**
   * A name for this step.
   *
   * Doubles as the anchor `goto` jumps to, which is why jumping never breaks
   * when steps move: the name travels with the step, unlike "the seventh one".
   * It also earns its keep on scripts that never jump — the row shows it
   * instead of a bare 依文字點擊, the run log prefixes its lines with it, and a
   * folded block leads with it, so a long script folds into a table of
   * contents rather than a list of identical verbs.
   */
  label?: string;
};

/**
 * What a variable holds. The type is chosen when the variable is declared, and
 * it decides everything downstream: which comparisons `ifVar` offers, which
 * control the editor shows for an argument, and which variables are listed
 * where a value is wanted. A wrong pairing is never offered rather than
 * offered and then rejected.
 */
export type ScriptVarType = "number" | "text" | "boolean" | "image" | "region";

/**
 * A named value inside one script.
 *
 * `in` is supplied by whoever calls this script as a module, `out` is handed
 * back to them, `local` never leaves. A module sees its own variables and
 * nothing else — the caller's are not visible — so the same module behaves the
 * same way wherever it is used, which is the only reason calling it is safer
 * than copying its steps.
 */
export interface ScriptVariable {
  name: string;
  type: ScriptVarType;
  kind: "in" | "out" | "local";
  /** For `in`: used when the caller leaves the argument empty. */
  default?: string | number | boolean | ScriptTemplate | ScriptRegion;
}

/** One argument at a call site: a value typed in, or another variable. */
export interface ScriptArg {
  param: string;
  value?: string | number | boolean | ScriptTemplate | ScriptRegion;
  fromVar?: string;
}

type ScriptStepKind =
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
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
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
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
    }
  /** Branch on whether the template is on screen right now. */
  | {
      type: "ifImage";
      template: ScriptTemplate;
      threshold: number;
      region?: ScriptRegion;
      then: ScriptStep[];
      else?: ScriptStep[];
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
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
      /**
       * Tap this far from the matched words instead of on them, normalized.
       *
       * Relative to the match, not the screen, so it follows the target as it
       * moves — which is the whole reason to use a label as an anchor for
       * something next to it: a row's button, the checkbox beside a name.
       */
      offsetX?: number;
      offsetY?: number;
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
    }
  /** Branch on whether recognised text contains `text`. */
  | {
      type: "ifText";
      text: string;
      region?: ScriptRegion;
      then: ScriptStep[];
      else?: ScriptStep[];
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
    }
  /**
   * Run another script here, as a step.
   *
   * The module gets only what `args` supply and gives back only what `outputs`
   * name, so it cannot be affected by — or affect — anything else in the
   * caller. Deliberately carries no branches of its own: a module that wants to
   * report success declares a boolean output, and the caller asks about it with
   * `ifVar` like any other value. One way to branch, not two.
   */
  | { type: "call"; scriptId: string; args: ScriptArg[]; outputs: { param: string; toVar: string }[] }
  /**
   * Continue from the step whose name is `target` instead of the next one.
   *
   * The target must be labelled in the same list or an enclosing one — jumping
   * into a branch or a loop body from outside would mean entering a context
   * that does not exist yet. Jumping backwards is a loop, which is the point
   * (retry until something works); the engine's step ceiling is what stops one
   * that never finishes.
   */
  | { type: "goto"; target: string }
  /**
   * Stop, at a chosen level.
   *
   * `script` ends the run; `loop` leaves the nearest 重複 and carries on after
   * it; `iteration` abandons this pass and starts the next; `module` returns to
   * whatever called this script, with its outputs as they stand. A scope that
   * has nothing to act on (leaving a loop when not in one) is a mistake worth
   * catching when it is written, not when it runs.
   */
  | { type: "stop"; scope: "script" | "loop" | "iteration" | "module" }
  /** Branch on a variable. Which comparisons are legal depends on its type. */
  | {
      type: "ifVar";
      name: string;
      compare: ">" | ">=" | "<" | "<=" | "==" | "!=" | "contains" | "isTrue" | "isFalse";
      /** Absent for `isTrue`/`isFalse`, which ask about the variable alone. */
      value?: string | number;
      /** Compare against another variable instead of a fixed value. */
      fromVar?: string;
      then: ScriptStep[];
      else?: ScriptStep[];
    }
  /** Read the first number in the region and compare it. */
  | {
      type: "ifNumber";
      region?: ScriptRegion;
      compare: ">" | ">=" | "<" | "<=" | "==";
      value: number;
      then: ScriptStep[];
      else?: ScriptStep[];
      /** Keep what this step found, under a declared variable name. */
      saveTo?: string;
    }
  /**
   * Which of several pictures is on screen — one capture, every template.
   *
   * Asking the same question with a chain of 找圖 steps costs one ~350 ms
   * screencap each, and the answer is stale by the time the last one runs. Here
   * the frame is taken once and every case is matched against that same moment,
   * so the answer describes one instant rather than a second of drift.
   */
  | {
      type: "identify";
      cases: IdentifyCase[];
      timeoutMs: number;
      /** Name of the case that won, or "" if the timeout passed with none. */
      saveTo?: string;
      /** Where it was found, in the coordinate space taps use — so the branch
       * that follows can act on it without capturing the screen again. */
      saveX?: string;
      saveY?: string;
    }
  /**
   * Start, stop, or restart an app.
   *
   * The reason a script wants this is almost always the same one: something has
   * gone wrong — a stuck loading screen, a session the server dropped — and the
   * cheapest way back to a known state is to kill it and open it again.
   */
  | {
      type: "app";
      action: ScriptAppAction;
      /** Android package name, e.g. `com.example.game`. */
      package: string;
      /**
       * How long to wait for a started app to reach the foreground before
       * carrying on regardless. Without this the next step runs against a
       * splash screen, or against whatever was on top before.
       */
      waitMs?: number;
    };

/** What an `app` step does to it. */
export type ScriptAppAction = "restart" | "start" | "stop";

/** One candidate in an 辨識情境 step: a picture, what to call it, how sure to be. */
export interface IdentifyCase {
  name: string;
  template: ScriptTemplate;
  threshold: number;
  region?: ScriptRegion;
}

/** What each step is called. Shared so the runner's log says the same word the
 * editor puts on the row, and a log line can be matched to what produced it. */
export const SCRIPT_STEP_LABELS: Record<ScriptStep["type"], string> = {
  goto: "跳到標記",
  stop: "停止",
  call: "呼叫模組",
  ifVar: "若變數",
  findTap: "找圖點擊",
  identify: "辨識情境",
  app: "App 啟停",
  ifImage: "若找到圖",
  tapText: "依文字點擊",
  ifText: "若文字含",
  ifNumber: "讀取數值",
  tap: "點擊",
  swipe: "滑動",
  wait: "等待",
  waitColor: "等待顏色",
  ifColor: "若顏色",
  loop: "重複",
  text: "輸入文字",
  key: "按鍵",
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
  /**
   * Callable from another script as a step, and kept out of the scheduler.
   *
   * A module is an ordinary script — same steps, same editor — so anything can
   * become one and a module can call further modules. The flag only decides
   * where it appears: in the call picker, or in the schedule.
   */
  isModule?: boolean;
  /** Declared values: what it takes, what it returns, what it keeps. */
  variables?: ScriptVariable[];
  /**
   * Devices the scheduler runs this on. A script is a procedure, not a
   * property of one phone — coordinates are normalized and text matching is
   * resolution-independent, so the same steps genuinely port across devices.
   *
   * Only `persistent` and `daily` consult this; a manual run always targets the
   * device you pressed 執行 from, whether or not it is listed here.
   *
   * Image steps are the exception worth knowing about: template matching is not
   * scale-invariant, so a script that finds images will miss on a device with a
   * different resolution than the one the template was captured on.
   */
  devices: string[];
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
  | "outranked"
  /** The device can't be reached, so the run cannot start at all. */
  | "unreachable";

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
  /**
   * Require the text to be this colour, `#rrggbb`, within `colorTolerance`.
   *
   * Far more discriminating than the words alone: an enabled button's label
   * and a greyed-out one read identically, and so do an ordinary item and a
   * rare one. Set it by clicking the swatch of a candidate that is already the
   * right colour rather than by guessing a hex value.
   */
  color?: string;
  /** 0-1 of the maximum RGB distance. */
  colorTolerance?: number;
  /** Text height as a fraction of the frame, for telling a heading from body
   * text that happens to say the same thing. */
  minHeight?: number;
  maxHeight?: number;
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
  /** The colour of the glyphs themselves, `#rrggbb` (text candidates only). */
  color?: string;
}

/** Largest possible distance between two RGB triples. */
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);

const parseRgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Whether two `#rrggbb` colours are within `tolerance` (0-1) of each other. */
export function scriptColorMatches(a: string, b: string, tolerance: number): boolean {
  const x = parseRgb(a);
  const y = parseRgb(b);
  if (!x || !y) return false;
  const d = Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
  return d / MAX_RGB_DISTANCE <= tolerance;
}

/** Why a candidate was dropped. The preview shows this; a filter that removes
 * things silently is impossible to debug. */
export type ScriptRejectReason = "mode" | "confidence" | "color" | "height";

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

/** The first filter a candidate fails, or null when it passes all of them. */
function rejectionFor(c: ScriptCandidate, needle: string | undefined, f: ScriptFilter): ScriptRejectReason | null {
  if (needle && c.lineText !== undefined && !scriptTextMatchesMode(c.lineText, needle, f.mode)) return "mode";
  if (f.minConfidence != null && c.confidence < f.minConfidence) return "confidence";
  if (f.color && c.color && !scriptColorMatches(c.color, f.color, f.colorTolerance ?? 0.15)) return "color";
  if (f.minHeight != null && c.h < f.minHeight) return "height";
  if (f.maxHeight != null && c.h > f.maxHeight) return "height";
  return null;
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
    const reason = rejectionFor(candidate, needle, filter);
    if (reason) rejected.push({ candidate, reason });
    else kept.push(candidate);
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

/** Scripts saved when they belonged to one device carry `deviceSerial`. */
export function scriptMigrateDevices<T extends { devices?: string[] }>(script: T & { deviceSerial?: string }): T {
  if (script.devices) return script;
  const { deviceSerial, ...rest } = script;
  return { ...rest, devices: deviceSerial ? [deviceSerial] : [] } as T;
}
