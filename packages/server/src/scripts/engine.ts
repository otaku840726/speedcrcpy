import type { Script, ScriptKey, ScriptLogEntry, ScriptStatus, ScriptStep } from "@speedcrcpy/shared";
import type { Adb } from "@yume-chan/adb";
import type { AdbManager } from "../adb/adb-manager.js";

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

async function sh(adb: Adb, command: string): Promise<string> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported) throw new Error("shell protocol unavailable");
  const { stdout } = await shell.spawnWait(command);
  return decoder.decode(stdout);
}

/** Stop signal thrown to unwind out of nested loops when a run is cancelled. */
class Stopped extends Error {}

interface Run {
  script: Script;
  startedAt: number;
  stepsRun: number;
  stopping: boolean;
  log: ScriptLogEntry[];
  /** Logical display size, resolved once per run — normalized coords map onto it. */
  width: number;
  height: number;
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

  constructor(private readonly adbManager: AdbManager) {}

  isRunning(serial: string): boolean {
    return this.runs.has(serial);
  }

  status(serial: string): ScriptStatus {
    const run = this.runs.get(serial);
    const last = run ?? this.finished.get(serial);
    if (!last) {
      return { serial, scriptId: null, scriptName: null, state: "idle", stepsRun: 0, startedAt: null, log: [] };
    }
    return {
      serial,
      scriptId: last.script.id,
      scriptName: last.script.name,
      state: !run ? "idle" : run.stopping ? "stopping" : "running",
      stepsRun: last.stepsRun,
      startedAt: last.startedAt,
      log: last.log,
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
  async start(script: Script): Promise<void> {
    const serial = script.deviceSerial;
    if (this.runs.has(serial)) throw new Error("script already running on this device");

    const adb = await this.adbManager.getAdb(serial);
    const { width, height } = await this.logicalSize(adb);
    const run: Run = {
      script,
      startedAt: Date.now(),
      stepsRun: 0,
      stopping: false,
      log: [],
      width,
      height,
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
    for (const step of steps) {
      this.checkStop(run);
      await this.runStep(adb, run, step);
    }
  }

  private async runStep(adb: Adb, run: Run, step: ScriptStep): Promise<void> {
    if (++run.stepsRun > MAX_STEPS_PER_RUN) throw new Error("超過步驟上限,已中止");

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
        // `input text` takes no spaces; %s is the documented escape.
        const escaped = step.value.replace(/(["\\$`])/g, "\\$1").replace(/ /g, "%s");
        await sh(adb, `input text "${escaped}"`);
        this.log(run, `輸入文字 (${step.value.length} 字)`);
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
          await this.runSteps(adb, run, step.body);
          // Yield so a forever-loop of instant steps can't starve the process.
          await this.sleep(0);
        }
        return;
      }
    }
  }

  /** Normalized (0-1) → logical pixels, clamped inside the display. */
  private toPixels(run: Run, x: number, y: number): [number, number] {
    const px = Math.min(run.width - 1, Math.max(0, Math.round(x * run.width)));
    const py = Math.min(run.height - 1, Math.max(0, Math.round(y * run.height)));
    return [px, py];
  }

  /** Logical size = what screencap returns and what `input` maps onto. */
  private async logicalSize(adb: Adb): Promise<{ width: number; height: number }> {
    const out = await sh(adb, "wm size");
    const override = out.match(/Override size:\s*(\d+)x(\d+)/);
    const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
    const m = override ?? physical;
    if (!m) throw new Error("could not read wm size");
    return { width: Number(m[1]), height: Number(m[2]) };
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

  private log(run: Run, message: string): void {
    run.log.push({ at: Date.now(), message });
    if (run.log.length > MAX_LOG) run.log.shift();
  }
}
