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

export type ScriptStep =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number }
  /** Fixed delay when min === max, otherwise a uniform random delay in between. */
  | { type: "wait"; minMs: number; maxMs: number }
  | { type: "text"; value: string }
  | { type: "key"; key: ScriptKey }
  /** `count` <= 0 means loop forever (until stopped or preempted). */
  | { type: "loop"; count: number; body: ScriptStep[] };

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
