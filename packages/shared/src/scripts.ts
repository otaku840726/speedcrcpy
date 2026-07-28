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
    };

export interface Script {
  id: string;
  deviceSerial: string;
  name: string;
  steps: ScriptStep[];
}

export type ScriptRunState = "idle" | "running" | "stopping";

export interface ScriptLogEntry {
  /** Epoch ms. */
  at: number;
  message: string;
}

export interface ScriptStatus {
  serial: string;
  scriptId: string | null;
  scriptName: string | null;
  state: ScriptRunState;
  /** Steps executed since this run started. */
  stepsRun: number;
  startedAt: number | null;
  log: ScriptLogEntry[];
}
