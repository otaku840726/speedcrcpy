import {
  type ScriptCandidate,
  type ScriptPick,
  type ScriptSelection,
  SCRIPT_STEP_LABELS,
  scriptSelect,
} from "@speedcrcpy/shared";
import type {
  Script,
  ScriptArg,
  ScriptKey,
  ScriptLogEntry,
  ScriptRegion,
  ScriptStatus,
  ScriptStep,
  ScriptTemplate,
} from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import type { AdbManager } from "../adb/adb-manager.js";
import { foregroundApp, isPackageName, startApp, stopApp } from "../scrcpy/apps.js";
import { parseNumber, textMatches } from "./ocr.js";
import { findTemplate, identify, recognize } from "./vision-offload.js";
import { capture, colorAt, colorMatches, parseHex } from "./vision.js";
import type { Frame } from "./vision.js";

const decoder = new TextDecoder();

/** Android keycodes for the keys a script may press. */
const KEYCODES: Record<ScriptKey, number> = {
  back: 4,
  home: 3,
  recents: 187,
  power: 26,
  wake: 224,
  volumeUp: 24,
  volumeDown: 25,
};

const MAX_LOG = 200;
/** Safety net: a "forever" loop still yields, and a runaway script is bounded. */
const MAX_STEPS_PER_RUN = 100_000;
/** Gap between vision polls — screencap itself costs ~350ms, so keep this small. */
const POLL_INTERVAL_MS = 150;

const hex = (c: { r: number; g: number; b: number }): string =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

const templateBytes = (template: ScriptTemplate): Uint8Array => Buffer.from(template.png, "base64");

async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  try {
    const { stdout } = await shell.spawnWait(command);
    return decoder.decode(stdout);
  } catch (error) {
    // Same as in `capture`: a dropped adb stream surfaces as an opaque struct
    // error, so say what actually happened.
    throw new Error(`與裝置的連線中斷(${command.split(" ")[0]}:${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Stop signal thrown to unwind out of nested loops when a run is cancelled. */
class Stopped extends Error {}

/**
 * Control flow that has to cross a boundary someone else owns.
 *
 * A jump has to leave the list it was written in if its target is further out;
 * leaving a loop has to unwind whatever branches sit between the step and the
 * loop; returning from a module has to pass every one of those on the way. All
 * three are therefore thrown rather than returned, and each is caught by
 * exactly the level that owns it: `runSteps` catches a jump whose target is on
 * its own list, the loop catches its own break and continue, and the call step
 * catches a module return. Anything not owned here keeps travelling.
 */
class Jump extends Error {
  constructor(readonly target: string) {
    super(`goto ${target}`);
  }
}
class Leave extends Error {
  constructor(readonly scope: "loop" | "iteration" | "module") {
    super(`stop ${scope}`);
  }
}

/**
 * The values a script can see while it runs.
 *
 * One of these per script *activation*, not per run: calling a module makes a
 * fresh scope holding only the arguments it was given, so a module cannot read
 * or clobber anything belonging to whoever called it. That isolation is the
 * whole reason calling a module is safer than pasting its steps.
 */
type Scope = Map<string, unknown>;

interface Run {
  script: Script;
  serial: string;
  startedAt: number;
  stepsRun: number;
  stopping: boolean;
  log: ScriptLogEntry[];
  /** Logical display size, resolved once per run — normalized coords map onto it. */
  width: number;
  height: number;
  /** Template capture sizes already warned about (warn once per run). */
  scaleWarned: Set<string>;
  /** A failed capture is logged once, not once per poll. */
  captureWarned: boolean;
  /** The script's own variables; a module call runs against a different one. */
  scope: Scope;
  /** How many module calls deep — a backstop under the cycle check that runs at
   * save time, since a script can be edited between saving and running. */
  depth: number;
  /** The name of the step being run, prefixed onto its log lines. */
  labelling?: string;
}

/** Modules can call modules; this is where that stops being sane. */
const MAX_CALL_DEPTH = 12;

/** The variables a script starts with when nobody called it: declared inputs
 * fall back to their defaults, everything else begins unset. */
function initialScope(script: Script): Scope {
  const scope: Scope = new Map();
  for (const v of script.variables ?? []) if (v.kind === "in" && v.default !== undefined) scope.set(v.name, v.default);
  return scope;
}

/**
 * The scope a module runs in: its own declared inputs, filled from the call
 * site, and nothing else. A caller variable reaches the module only by being
 * named in an argument — which is what makes a module behave the same way
 * wherever it is used.
 */
function callScope(module: Script, args: ScriptArg[], caller: Scope): Scope {
  const scope = initialScope(module);
  for (const arg of args) {
    const value = arg.fromVar ? caller.get(arg.fromVar) : arg.value;
    if (value !== undefined) scope.set(arg.param, value);
  }
  return scope;
}

/** Readable in a log line without dumping a base64 template into it. */
function describeValue(value: unknown): string {
  if (value === undefined) return "(未設定)";
  if (typeof value === "boolean") return value ? "真" : "假";
  if (typeof value === "object") return "(圖像/範圍)";
  return String(value).slice(0, 40);
}

/**
 * Compare per the operator the editor offered, which is already narrowed by the
 * variable's type. An unset variable never satisfies a comparison — a script
 * that reads nothing should take the "else" branch rather than a coincidence.
 */
function compareVar(left: unknown, compare: string, right: unknown): boolean {
  if (compare === "isTrue") return left === true;
  if (compare === "isFalse") return left === false;
  if (left === undefined || right === undefined) return false;
  if (compare === "contains") return String(left).includes(String(right));
  if (compare === "==") return String(left) === String(right);
  if (compare === "!=") return String(left) !== String(right);
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return compare === ">" ? a > b : compare === ">=" ? a >= b : compare === "<" ? a < b : a <= b;
}

/**
 * Per-device script runner. One script per device at a time; everything goes
 * through plain adb so a script runs whether or not anyone is viewing.
 *
 * Coordinates are normalized (0-1) and mapped onto the device's **logical**
 * display (what `screencap` returns and what `input` expects), so scripts
 * survive resolution overrides and rotation.
 */
export class ScriptEngine {
  private readonly runs = new Map<string, Run>();
  /** Last finished run per device, so the UI can still show its outcome + log. */
  private readonly finished = new Map<string, Run>();
  /** Notified the moment a device frees up, so the scheduler can fill it
   * immediately instead of waiting for its next tick. */
  private onIdle: ((serial: string) => void) | undefined;
  /** Offered every frame a step captures, so the thumbnail cache can ride along
   * instead of screencapping the same device again on its own timer. */
  private onFrame: ((serial: string, frame: Frame) => void) | undefined;
  /** How a `call` step finds the script it names. */
  private resolveScript: ((id: string) => Script | undefined) | undefined;
  /** Every log line, for anything that shows what a script was doing beside
   * something else — the device replay reads them as captions. */
  private onLogLine: ((serial: string, scriptName: string, message: string) => void) | undefined;

  constructor(private readonly adbManager: AdbManager) {}

  onDeviceIdle(handler: (serial: string) => void): void {
    this.onIdle = handler;
  }

  onCapture(handler: (serial: string, frame: Frame) => void): void {
    this.onFrame = handler;
  }

  onLog(handler: (serial: string, scriptName: string, message: string) => void): void {
    this.onLogLine = handler;
  }

  onResolveScript(resolve: (id: string) => Script | undefined): void {
    this.resolveScript = resolve;
  }

  isRunning(serial: string): boolean {
    return this.runs.has(serial);
  }

  status(serial: string): ScriptStatus {
    const run = this.runs.get(serial);
    const last = run ?? this.finished.get(serial);
    if (!last) {
      return { serial, scriptId: null, scriptName: null, state: "idle", stepsRun: 0, startedAt: null, log: [], pending: null };
    }
    return {
      serial,
      scriptId: last.script.id,
      scriptName: last.script.name,
      state: !run ? "idle" : run.stopping ? "stopping" : "running",
      stepsRun: last.stepsRun,
      startedAt: last.startedAt,
      log: last.log,
      pending: null,
    };
  }

  /** Ask the active run to stop; it unwinds at the next step boundary. */
  stop(serial: string): boolean {
    const run = this.runs.get(serial);
    if (!run) return false;
    run.stopping = true;
    this.log(run, "收到停止要求");
    return true;
  }

  /** Start a script. Rejects if the device already has one running. */
  async start(script: Script, serial: string): Promise<void> {
    if (this.runs.has(serial)) throw new Error("這台裝置正在執行腳本,先停止才能單獨執行一段");

    const adb = await this.adbManager.getAdb(serial);
    const { width, height } = await this.frameSize(adb);
    const run: Run = {
      script,
      serial,
      startedAt: Date.now(),
      stepsRun: 0,
      stopping: false,
      log: [],
      width,
      height,
      scaleWarned: new Set(),
      captureWarned: false,
      // A top-level run has no caller, so its `in` variables can only be their
      // defaults; `local` and `out` start empty and are filled by steps.
      scope: initialScope(script),
      depth: 0,
    };
    this.runs.set(serial, run);
    this.finished.delete(serial);
    this.log(run, `開始「${script.name}」· 顯示 ${width}×${height}`);

    // Fire-and-forget: callers poll status/log.
    void this.execute(adb, run)
      .then(() => this.log(run, run.stopping ? "已停止" : "執行完成"))
      .catch((error: unknown) => {
        if (error instanceof Stopped) this.log(run, "已停止");
        else this.log(run, `錯誤:${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        // Free the device, but retain the run so its outcome + log stay
        // readable until the next run replaces it.
        this.runs.delete(serial);
        this.finished.set(serial, run);
        this.onIdle?.(serial);
      });
  }

  // ---- internals ----

  private async execute(adb: Adb, run: Run): Promise<void> {
    // Vision and input need an awake display: screencap is all black while the
    // device dozes. Wake first, then dismiss a swipe-only lock screen.
    await this.wake(adb, run);
    await this.runSteps(adb, run, run.script.steps);
  }

  private async wake(adb: Adb, run: Run): Promise<void> {
    const power = await sh(adb, "dumpsys power | grep -m1 mWakefulness=");
    if (/mWakefulness=Awake/.test(power)) return;
    await sh(adb, `input keyevent ${KEYCODES.wake}`);
    await this.sleep(600);
    // Swipe up to dismiss a PIN-less lock screen (a secured one needs the user).
    await sh(adb, `input swipe ${Math.round(run.width / 2)} ${Math.round(run.height * 0.8)} ${Math.round(run.width / 2)} ${Math.round(run.height * 0.2)} 200`);
    await this.sleep(400);
    this.log(run, "已喚醒螢幕");
  }

  private async runSteps(adb: Adb, run: Run, steps: ScriptStep[]): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      this.checkStop(run);
      // Switched off, not deleted. Said out loud rather than skipped in silence:
      // a script that does nothing where you expected something is a worse
      // puzzle than a log line saying which step is parked. A disabled loop or
      // if-step never runs, so its children never run either.
      if (step.disabled) {
        this.log(run, `略過(已關閉):${this.name(step)}`);
        continue;
      }
      try {
        await this.runStep(adb, run, step);
      } catch (error) {
        // A jump lands here if this list holds the label; otherwise it belongs
        // to a list further out and keeps going.
        if (!(error instanceof Jump)) throw error;
        const target = steps.findIndex((s) => s.label === error.target);
        if (target < 0) throw error;
        this.log(run, `跳到「${error.target}」`);
        i = target - 1;
      }
    }
  }

  /** What to call a step in the log: its name if it has one. */
  private name(step: ScriptStep): string {
    const kind = SCRIPT_STEP_LABELS[step.type];
    return step.label ? `${step.label}(${kind})` : kind;
  }

  /** "(3 個中的第 2 個)" — silent when there was only ever one candidate, so
   * the log stays quiet until ambiguity is actually in play. `random` always
   * says which one it landed on, or a surprise is unexplainable after the fact. */
  private nth(pick: ScriptSelection<ScriptCandidate>, config: ScriptPick | undefined): string {
    const index = (config?.index ?? 0) + 1;
    if (config?.by === "random") return `(隨機取 ${pick.kept.length} 個中的第 ${pick.kept.indexOf(pick.chosen!) + 1} 個)`;
    return pick.kept.length > 1 ? `(${pick.kept.length} 個中的第 ${index})` : "";
  }

  /** Why nothing was acted on — a filter that eats a match silently is
   * impossible to debug from a log. */
  private why(pick: ScriptSelection<ScriptCandidate>, read: string): string {
    if (pick.unsettled) return `讀到 ${pick.kept.length} 個,但設定為必須剛好 1 個`;
    if (pick.kept.length) return `符合 ${pick.kept.length} 個,取不到指定的第幾個`;
    if (pick.rejected.length) {
      const modes = pick.rejected.filter((r) => r.reason === "mode").length;
      const low = pick.rejected.length - modes;
      return `${pick.rejected.length} 個被濾掉(前後有字 ${modes}、信心度不足 ${low})`;
    }
    return `讀到:${read.slice(0, 40) || "(空)"}`;
  }

  /**
   * A frame for a polling step, or undefined when the capture failed.
   *
   * A step that already polls to a deadline should treat a dropped frame as one
   * unsuccessful attempt, not as a reason to abandon the run: adb over the
   * network blips, and screencap moves ~8 MB per attempt so it is the most
   * likely thing to be caught by one. Logged once per run — a device that is
   * really gone would otherwise fill the log with the same line.
   */
  /** Capture, and let everything that wants a copy of the picture have one. */
  private async grab(run: Run, adb: Adb): Promise<Frame> {
    const frame = await capture(adb);
    this.onFrame?.(run.serial, frame);
    return frame;
  }

  private async pollFrame(run: Run, adb: Adb): Promise<Frame | undefined> {
    try {
      return await this.grab(run, adb);
    } catch (error) {
      if (!run.captureWarned) {
        run.captureWarned = true;
        this.log(run, `擷取畫面失敗,重試中:${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    }
  }

  /** Vision steps already hold a frame — resync the mapping so a rotation
   * that happens mid-run is picked up immediately. */
  private syncSize(run: Run, frame: { width: number; height: number }): void {
    if (run.width === frame.width && run.height === frame.height) return;
    run.width = frame.width;
    run.height = frame.height;
    this.log(run, `畫面尺寸變更 → ${frame.width}×${frame.height}`);
  }

  private async runStep(adb: Adb, run: Run, step: ScriptStep): Promise<void> {
    if (++run.stepsRun > MAX_STEPS_PER_RUN) throw new Error("超過步驟上限,已中止");
    // Named steps prefix their log lines, which is the difference between
    // reading a log of twenty 依文字點擊 and reading one that says which.
    run.labelling = step.label;

    switch (step.type) {
      case "tap": {
        const [x, y] = this.toPixels(run, step.x, step.y);
        await sh(adb, `input tap ${x} ${y}`);
        this.log(run, `點擊 (${step.x.toFixed(3)}, ${step.y.toFixed(3)}) → ${x},${y}`);
        return;
      }
      case "swipe": {
        const [x1, y1] = this.toPixels(run, step.x1, step.y1);
        const [x2, y2] = this.toPixels(run, step.x2, step.y2);
        await sh(adb, `input swipe ${x1} ${y1} ${x2} ${y2} ${Math.max(1, Math.round(step.durationMs))}`);
        this.log(run, `滑動 ${x1},${y1} → ${x2},${y2} (${step.durationMs}ms)`);
        return;
      }
      case "wait": {
        const lo = Math.max(0, Math.min(step.minMs, step.maxMs));
        const hi = Math.max(0, Math.max(step.minMs, step.maxMs));
        const ms = lo === hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
        this.log(run, `等待 ${ms}ms`);
        await this.sleep(ms, run);
        return;
      }
      case "text": {
        const typed = this.fill(run, step.value);
        // `input text` takes no spaces; %s is the documented escape.
        const escaped = typed.replace(/(["\\$`])/g, "\\$1").replace(/ /g, "%s");
        await sh(adb, `input text "${escaped}"`);
        this.log(run, `輸入文字 (${typed.length} 字)`);
        return;
      }
      case "key": {
        await sh(adb, `input keyevent ${KEYCODES[step.key]}`);
        this.log(run, `按鍵 ${step.key}`);
        return;
      }
      case "loop": {
        const forever = step.count <= 0;
        for (let i = 0; forever || i < step.count; i++) {
          this.checkStop(run);
          this.log(run, `迴圈 #${i + 1}${forever ? "" : `/${step.count}`}`);
          try {
            await this.runSteps(adb, run, step.body);
          } catch (error) {
            // This loop is the nearest one, so it owns both of these; anything
            // else (a module return, a jump to an outer label) travels on.
            if (!(error instanceof Leave) || error.scope === "module") throw error;
            if (error.scope === "loop") return;
          }
          // Yield so a forever-loop of instant steps can't starve the process.
          await this.sleep(0);
        }
        return;
      }
      case "waitColor": {
        const want = parseHex(step.color);
        const deadline = Date.now() + step.timeoutMs;
        for (;;) {
          this.checkStop(run);
          const frame = await this.pollFrame(run, adb);
          if (frame) {
            this.syncSize(run, frame);
            const got = colorAt(frame, step.x, step.y);
            if (colorMatches(got, want, step.tolerance)) {
              this.log(run, `等待顏色 ${step.color} 命中 (${hex(got)})`);
              return;
            }
            if (Date.now() >= deadline) {
              this.log(run, `等待顏色 ${step.color} 逾時(目前 ${hex(got)})`);
              return;
            }
          } else if (Date.now() >= deadline) {
            this.log(run, `等待顏色 ${step.color} 逾時:期間都擷取不到畫面`);
            return;
          }
          await this.sleep(POLL_INTERVAL_MS, run);
        }
      }
      case "ifColor": {
        const frame = await this.grab(run, adb);
        this.syncSize(run, frame);
        const got = colorAt(frame, step.x, step.y);
        const hit = colorMatches(got, parseHex(step.color), step.tolerance);
        this.save(run, step.saveTo, hit);
        this.log(run, `若顏色 ${step.color}:${hit ? "符合" : `不符(${hex(got)})`}`);
        await this.runSteps(adb, run, (hit ? step.then : step.else) ?? []);
        return;
      }
      case "findTap": {
        const deadline = Date.now() + step.timeoutMs;
        for (;;) {
          this.checkStop(run);
          const frame = await this.pollFrame(run, adb);
          if (frame) {
            this.syncSize(run, frame);
            this.warnTemplateScale(run, step.template, frame.width, frame.height);
            const match = await findTemplate(frame, templateBytes(step.template), step.region, step.threshold);
            const sel = scriptSelect(match.matches, undefined, step.filter, step.pick, frame);
            if (sel.chosen) {
              const nx = sel.chosen.x + (step.offsetX ?? 0);
              const ny = sel.chosen.y + (step.offsetY ?? 0);
              const [px, py] = this.toPixels(run, nx, ny);
              await sh(adb, `input tap ${px} ${py}`);
              this.save(run, step.saveTo, true);
              this.log(run, `找圖命中 ${this.nth(sel, step.pick)} ${(sel.chosen.confidence * 100).toFixed(0)}% → 點擊 ${px},${py}`);
              return;
            }
            if (Date.now() >= deadline) {
              this.save(run, step.saveTo, false);
              this.log(
                run,
                match.matches.length
                  ? `找圖逾時 · ${this.why(sel, "")}`
                  : `找圖逾時(最佳 ${(match.score * 100).toFixed(0)}% < ${(step.threshold * 100).toFixed(0)}%)`,
              );
              return;
            }
          } else if (Date.now() >= deadline) {
            this.save(run, step.saveTo, false);
            this.log(run, "找圖逾時:期間都擷取不到畫面");
            return;
          }
          await this.sleep(POLL_INTERVAL_MS, run);
        }
      }
      case "app": {
        if (!isPackageName(step.package)) {
          this.log(run, `App 啟停:「${step.package}」不是有效的套件名稱`);
          return;
        }
        if (step.action !== "start") {
          await stopApp(adb, step.package);
          this.log(run, `已關閉 ${step.package}`);
        }
        if (step.action === "stop") return;
        await startApp(adb, step.package);
        // Launching returns as soon as the intent is sent, so without this the
        // next step looks at whatever was on screen before — usually the
        // launcher, briefly, which matches nothing and burns the next step's
        // whole timeout.
        const waitMs = step.waitMs ?? 0;
        const deadline = Date.now() + waitMs;
        for (;;) {
          if (waitMs <= 0) break;
          this.checkStop(run);
          if ((await foregroundApp(adb)) === step.package) {
            this.log(run, `已啟動 ${step.package}`);
            return;
          }
          if (Date.now() >= deadline) {
            this.log(run, `已啟動 ${step.package},但 ${waitMs}ms 內沒有回到前景`);
            return;
          }
          await this.sleep(POLL_INTERVAL_MS, run);
        }
        this.log(run, `已啟動 ${step.package}`);
        return;
      }
      case "identify": {
        const deadline = Date.now() + step.timeoutMs;
        for (;;) {
          this.checkStop(run);
          const frame = await this.pollFrame(run, adb);
          if (frame) {
            this.syncSize(run, frame);
            for (const one of step.cases) this.warnTemplateScale(run, one.template, frame.width, frame.height);
            // One capture, one crossing, every template — the whole point of
            // the step. Each answer describes the same instant, which a chain
            // of 找圖 steps cannot say about itself.
            const scores = await identify(
              frame,
              step.cases.map((c) => ({ template: templateBytes(c.template), region: c.region, threshold: c.threshold })),
            );
            let best: { name: string; score: number; x: number; y: number; tap?: boolean } | undefined;
            scores.forEach((got, i) => {
              const one = step.cases[i];
              if (!one || got.score < one.threshold) return;
              if (!best || got.score > best.score) best = { name: one.name, tap: one.tap, ...got };
            });
            if (best) {
              const [px, py] = this.toPixels(run, best.x, best.y);
              // Tapping here rather than through a branch into 找圖點擊: that
              // would search for the same picture on a second capture, and the
              // screen it looks at is no longer the one that was recognised.
              if (best.tap) await sh(adb, `input tap ${px} ${py}`);
              this.save(run, step.saveTo, best.name);
              this.save(run, step.saveX, px);
              this.save(run, step.saveY, py);
              this.log(
                run,
                `辨識情境:${best.name} ${(best.score * 100).toFixed(0)}% @ ${px},${py}${best.tap ? " → 點擊" : ""}`,
              );
              return;
            }
            if (Date.now() >= deadline) {
              this.save(run, step.saveTo, "");
              // Everyone's best score, because "none of them matched" is not
              // actionable — which one nearly did, and by how much, is.
              const near = scores
                .map((got, i) => `${step.cases[i]?.name ?? i}:${(got.score * 100).toFixed(0)}%`)
                .join(" ");
              this.log(run, `辨識情境逾時,都不符合(${near})`);
              return;
            }
          } else if (Date.now() >= deadline) {
            this.save(run, step.saveTo, "");
            this.log(run, "辨識情境逾時:期間都擷取不到畫面");
            return;
          }
          await this.sleep(POLL_INTERVAL_MS, run);
        }
      }
      case "goto":
        throw new Jump(step.target);
      case "stop":
        if (step.scope === "script") {
          this.log(run, "停止:整支腳本");
          run.stopping = true;
          throw new Stopped();
        }
        this.log(run, `停止:${step.scope === "loop" ? "跳出迴圈" : step.scope === "iteration" ? "下一輪" : "結束模組"}`);
        throw new Leave(step.scope);
      case "call": {
        const module = this.resolveScript?.(step.scriptId);
        if (!module) throw new Error("找不到要呼叫的模組(可能已被刪除)");
        if (run.depth >= MAX_CALL_DEPTH) throw new Error(`模組呼叫太深(超過 ${MAX_CALL_DEPTH} 層),已中止`);

        // Only the arguments cross the boundary. Anything the module does not
        // declare as an input simply is not there, whatever the caller holds.
        const inner: Run = {
          ...run,
          script: module,
          scope: callScope(module, step.args, run.scope),
          depth: run.depth + 1,
        };
        this.log(run, `呼叫模組「${module.name}」`);
        try {
          await this.runSteps(adb, inner, module.steps);
        } catch (error) {
          // Returning early from the module is this step's business; a stop
          // aimed at the whole script is not.
          if (error instanceof Leave && error.scope === "module") {
            /* the module returned early — carry on with its outputs as they are */
          } else if (error instanceof Jump) {
            // A jump that got this far found no label inside the module. It
            // must not continue into the caller: names there are not the
            // module's to see, and one that happened to match would send the
            // run somewhere nobody wrote. Saving normally refuses this, but a
            // module can be edited after the caller was saved.
            throw new Error(`模組「${module.name}」裡的跳躍找不到標記「${error.target}」`);
          } else {
            throw error;
          }
        }
        // And only the declared outputs come back.
        for (const { param, toVar } of step.outputs) {
          if (inner.scope.has(param)) run.scope.set(toVar, inner.scope.get(param));
        }
        // The inner run shares the counters and log; carry the ones it moved.
        run.stepsRun = inner.stepsRun;
        run.width = inner.width;
        run.height = inner.height;
        return;
      }
      case "ifVar": {
        const left = run.scope.get(step.name);
        const right = step.fromVar ? run.scope.get(step.fromVar) : step.value;
        const hit = compareVar(left, step.compare, right);
        this.log(run, `若變數 ${step.name}(${describeValue(left)})${step.compare}${step.fromVar ?? describeValue(right)}:${hit ? "成立" : "不成立"}`);
        await this.runSteps(adb, run, (hit ? step.then : step.else) ?? []);
        return;
      }
      case "ifImage": {
        const frame = await this.grab(run, adb);
        this.syncSize(run, frame);
        this.warnTemplateScale(run, step.template, frame.width, frame.height);
        const match = await findTemplate(frame, templateBytes(step.template), step.region, step.threshold);
        const hit = match.matches.length > 0;
        // Tapping before the branch, on the frame that found it: a 找圖點擊
        // inside `then` would search for the same picture on a second capture,
        // and the screen it looks at is no longer the one that matched.
        let tapped = "";
        if (hit && step.tap) {
          const [px, py] = this.toPixels(run, match.x, match.y);
          await sh(adb, `input tap ${px} ${py}`);
          tapped = ` → 點擊 ${px},${py}`;
        }
        this.save(run, step.saveTo, hit);
        this.log(run, `若找到圖:${hit ? "是" : "否"}(${(match.score * 100).toFixed(0)}%)${tapped}`);
        await this.runSteps(adb, run, (hit ? step.then : step.else) ?? []);
        return;
      }
      case "tapText": {
        const deadline = Date.now() + step.timeoutMs;
        for (;;) {
          this.checkStop(run);
          const frame = await this.pollFrame(run, adb);
          if (frame) {
            this.syncSize(run, frame);
            // Matches are the words themselves, narrowed down from the band they
            // sit in — OCR merges a whole horizontal row (icon and all) into one
            // box, so its centre is rarely on the text you asked for.
            const needle = this.fill(run, step.text);
            const result = await recognize(frame, step.region, needle);
            const pick = scriptSelect(result.matches, needle, step.filter, step.pick, frame);
            if (pick.chosen) {
              const [px, py] = this.toPixels(run, pick.chosen.x + (step.offsetX ?? 0), pick.chosen.y + (step.offsetY ?? 0));
              await sh(adb, `input tap ${px} ${py}`);
              this.log(run, `找到文字「${pick.chosen.text}」${this.nth(pick, step.pick)} → 點擊 ${px},${py} (${result.ms}ms)`);
              return;
            }
            if (Date.now() >= deadline) {
              this.log(run, `找不到文字「${step.text}」逾時 · ${this.why(pick, result.text)}`);
              return;
            }
          } else if (Date.now() >= deadline) {
            this.log(run, `找不到文字「${step.text}」逾時:期間都擷取不到畫面`);
            return;
          }
          await this.sleep(POLL_INTERVAL_MS, run);
        }
      }
      case "ifText": {
        const result = await recognize(await this.grab(run, adb), step.region);
        const hit = textMatches(result.text, this.fill(run, step.text));
        this.save(run, step.saveTo, hit);
        this.log(run, `若文字含「${step.text}」:${hit ? "是" : `否(讀到:${result.text.slice(0, 30) || "空"})`}`);
        await this.runSteps(adb, run, (hit ? step.then : step.else) ?? []);
        return;
      }
      case "ifNumber": {
        const result = await recognize(await this.grab(run, adb), step.region);
        const value = parseNumber(result.text);
        const hit =
          value !== null &&
          ((step.compare === ">" && value > step.value) ||
            (step.compare === ">=" && value >= step.value) ||
            (step.compare === "<" && value < step.value) ||
            (step.compare === "<=" && value <= step.value) ||
            (step.compare === "==" && value === step.value));
        this.save(run, step.saveTo, value);
        this.log(run, `讀取數值:${value ?? "(讀不到)"} ${step.compare} ${step.value} → ${hit ? "成立" : "不成立"}`);
        await this.runSteps(adb, run, (hit ? step.then : step.else) ?? []);
        return;
      }
    }
  }

  /** Template matching is not scale-invariant — flag a resolution mismatch once. */
  private warnTemplateScale(run: Run, template: ScriptTemplate, width: number, height: number): void {
    if (template.capturedWidth === width && template.capturedHeight === height) return;
    const key = `${template.capturedWidth}x${template.capturedHeight}`;
    if (run.scaleWarned.has(key)) return;
    run.scaleWarned.add(key);
    this.log(run, `注意:模板擷取於 ${key},目前 ${width}×${height},比對可能失準`);
  }

  /** Normalized (0-1) → logical pixels, clamped inside the display. */
  private toPixels(run: Run, x: number, y: number): [number, number] {
    const px = Math.min(run.width - 1, Math.max(0, Math.round(x * run.width)));
    const py = Math.min(run.height - 1, Math.max(0, Math.round(y * run.height)));
    return [px, py];
  }

  /**
   * Coordinate space = the screencap frame, NOT `wm size`.
   *
   * Every coordinate in a script originates from a screencap (the editor's
   * pickers work on one, and vision steps derive matches from one), and
   * `input` maps onto the same rotated space. `wm size` reports the *unrotated*
   * logical size — on a landscape device it says 1080x1920 while screencap
   * returns 1920x1080, which would send every tap to the wrong place.
   */
  private async frameSize(adb: Adb): Promise<{ width: number; height: number }> {
    // Derived from `wm size` + rotation rather than a screencap: a capture costs
    // ~350 ms on an idle device but 5-9 s while a heavy game renders, which
    // would stall every script start. Vision steps correct this for free via
    // syncSize, since they hold a real frame anyway.
    const out = await sh(adb, "wm size; dumpsys display | grep -m1 -oE 'mCurrentOrientation=[0-9]+'");
    const size = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/);
    if (!size) throw new Error("could not read wm size");
    const width = Number(size[1]);
    const height = Number(size[2]);
    // `wm size` reports the unrotated logical size; landscape swaps the axes.
    const rotation = Number(out.match(/mCurrentOrientation=(\d+)/)?.[1] ?? 0);
    return rotation === 1 || rotation === 3 ? { width: height, height: width } : { width, height };
  }

  private checkStop(run: Run): void {
    if (run.stopping) throw new Stopped();
  }

  /** Interruptible sleep — wakes early (and throws) when a stop is requested. */
  private async sleep(ms: number, run?: Run): Promise<void> {
    const step = 100;
    let left = ms;
    do {
      if (run) this.checkStop(run);
      const slice = Math.min(step, left);
      await new Promise((resolve) => setTimeout(resolve, slice));
      left -= slice;
    } while (left > 0);
  }

  /**
   * Substitute {{name}} for what the variable holds.
   *
   * Only names the scope actually knows are replaced; anything else is left
   * exactly as typed. Scripts written before variables existed cannot change
   * meaning because of a stray pair of braces in their text.
   */
  private fill(run: Run, text: string): string {
    if (!text.includes("{{")) return text;
    return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, name: string) =>
      run.scope.has(name) ? String(run.scope.get(name) ?? "") : whole,
    );
  }

  /** Keep a step's result under a declared name, if the step asked to. */
  private save(run: Run, name: string | undefined, value: unknown): void {
    if (!name) return;
    run.scope.set(name, value);
    this.log(run, `  ${name} = ${describeValue(value)}`);
  }

  private log(run: Run, message: string): void {
    if (run.labelling) message = `[${run.labelling}] ${message}`;
    run.log.push({ at: Date.now(), message });
    this.onLogLine?.(run.serial, run.script.name, message);
    if (run.log.length > MAX_LOG) run.log.shift();
  }
}
