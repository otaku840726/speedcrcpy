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
  | { type: "tapText"; text: string; region?: ScriptRegion; timeoutMs: number }
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

/** Rough advance width: CJK and full-width glyphs take about twice a Latin one. */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x1100 && !(code >= 0x2000 && code <= 0x206f) ? 2 : 1;
}

const stripText = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Whitespace-insensitive containment, the way a script author means it. */
export function scriptTextMatches(haystack: string, needle: string): boolean {
  return stripText(haystack).includes(stripText(needle));
}

/**
 * Where to tap for `needle` inside a recognised line.
 *
 * OCR groups everything on one horizontal band into a single line, so the
 * line's own centre can sit far from the words that matched — an app icon and
 * its label routinely share a line, and tapping the middle hits the icon. This
 * estimates the substring's centre by advancing through the text, which is
 * close enough to land inside the words. A tight region is still the most
 * reliable way to aim.
 *
 * Returns normalized coordinates, or the line centre when the needle isn't in it.
 */
export function scriptTextTapPoint(
  line: { text: string; x: number; y: number; w: number; h: number },
  needle: string,
): { x: number; y: number } {
  const chars = [...line.text];
  // Map each stripped-text position back to its index in the original string.
  const originalIndex: number[] = [];
  let stripped = "";
  chars.forEach((ch, i) => {
    if (!/\s/.test(ch)) {
      stripped += ch.toLowerCase();
      originalIndex.push(i);
    }
  });

  const want = stripText(needle);
  const at = stripped.indexOf(want);
  if (!want || at < 0) return { x: line.x, y: line.y };

  const startChar = originalIndex[at] ?? 0;
  const endChar = (originalIndex[at + [...want].length - 1] ?? chars.length - 1) + 1;

  let total = 0;
  let before = 0;
  let inside = 0;
  chars.forEach((ch, i) => {
    const w = charWidth(ch);
    total += w;
    if (i < startChar) before += w;
    else if (i < endChar) inside += w;
  });
  if (total === 0) return { x: line.x, y: line.y };

  const centreFraction = (before + inside / 2) / total;
  return { x: line.x - line.w / 2 + centreFraction * line.w, y: line.y };
}
