import type { DeviceSchedule, ScheduleScript, Script, ScriptPendingReason } from "@speedcrcpy/shared";
import type { ScriptEngine } from "./engine.js";
import type { ScriptStore } from "./store.js";

const TICK_MS = 2_000;
/** Scripts stay off the device for this long after the last manual input. */
const HUMAN_IDLE_MS = 15_000;
/** Breather before a persistent script that ran to completion starts again. */
const RESTART_DELAY_MS = 3_000;
/** A manual run outranks everything, whatever the script's own priority. */
const MANUAL_BOOST = 1_000;

interface Activation {
  scriptId: string;
  priority: number;
  /** manual runs and daily firings are one-shot; persistent re-activates. */
  oneShot: boolean;
  since: number;
}

interface DeviceState {
  activations: Map<string, Activation>;
  lastHumanInputAt: number;
  /** Script the engine was last seen running, to detect completion. */
  lastRunning: string | null;
  /** Earliest time a persistent script may restart after finishing. */
  restartAfter: number;
}

/** `YYYY-M-D` in local time — the key for "already fired today". */
function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

function nextDailyRun(time: string, now: Date): number | null {
  const [h, m] = time.split(":").map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * Decides which script owns each device.
 *
 * A device runs the highest-priority script that currently wants it. Manual
 * input beats everything (scripts get out of the way while you touch the
 * device, and come back once you stop); otherwise a higher-priority
 * activation preempts a lower one — the classic case being a daily event
 * script interrupting a persistent farming script, which then resumes.
 *
 * Preempted scripts restart from the beginning: the device's UI state has
 * moved on, so resuming mid-way would be worse than starting over.
 */
export class Scheduler {
  private readonly devices = new Map<string, DeviceState>();
  /** `${scriptId}@${dayKey}` for daily triggers already fired. */
  private readonly firedDays = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ScriptStore,
    private readonly engine: ScriptEngine,
  ) {}

  start(): void {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), TICK_MS);
    // React the instant a device frees up rather than on the next tick.
    this.engine.onDeviceIdle(() => void this.tick().catch(() => {}));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Manual input on a device — hold scripts off until the user is done. */
  noteHumanInput(serial: string): void {
    this.state(serial).lastHumanInputAt = Date.now();
  }

  /** Queue a script to run now, outranking scheduled/persistent work. */
  requestRun(script: Script): void {
    const state = this.state(script.deviceSerial);
    state.activations.set(script.id, {
      scriptId: script.id,
      priority: script.priority + MANUAL_BOOST,
      oneShot: true,
      since: Date.now(),
    });
    void this.tick().catch(() => {});
  }

  /** Stop the running script and stop it from being re-scheduled immediately. */
  cancel(serial: string): void {
    const state = this.state(serial);
    const running = this.engine.status(serial).scriptId;
    if (running) state.activations.delete(running);
    this.engine.stop(serial);
  }

  /**
   * The script queued for a device but not yet running, and why — so the UI can
   * say "queued" / "you're touching the device" instead of looking dead.
   */
  pending(serial: string): { scriptId: string; reason: ScriptPendingReason } | null {
    const state = this.devices.get(serial);
    if (!state) return null;
    const desired = this.pick(state);
    if (!desired) return null;

    const status = this.engine.status(serial);
    const running = status.state === "idle" ? null : status.scriptId;
    if (running === desired.scriptId) return null; // it's the one running

    if (this.humanActive(serial)) return { scriptId: desired.scriptId, reason: "humanActive" };
    if (running) return { scriptId: desired.scriptId, reason: "outranked" };
    return { scriptId: desired.scriptId, reason: "queued" };
  }

  overview(): DeviceSchedule[] {
    const now = new Date();
    const bySerial = new Map<string, ScheduleScript[]>();
    for (const script of this.store.list()) {
      const state = this.devices.get(script.deviceSerial);
      const running = this.engine.status(script.deviceSerial);
      const isRunning = running.scriptId === script.id && running.state !== "idle";
      const waiting = state?.activations.has(script.id) ?? false;
      const list = bySerial.get(script.deviceSerial) ?? [];
      list.push({
        id: script.id,
        name: script.name,
        trigger: script.trigger,
        priority: script.priority,
        enabled: script.enabled,
        state: isRunning ? "running" : waiting ? "waiting" : "idle",
        nextRunAt:
          script.enabled && script.trigger.type === "daily" ? nextDailyRun(script.trigger.time, now) : null,
      });
      bySerial.set(script.deviceSerial, list);
    }
    return [...bySerial.entries()].map(([serial, scripts]) => ({
      serial,
      humanActive: this.humanActive(serial),
      scripts: scripts.sort((a, b) => b.priority - a.priority),
    }));
  }

  // ---- internals ----

  private state(serial: string): DeviceState {
    let state = this.devices.get(serial);
    if (!state) {
      state = { activations: new Map(), lastHumanInputAt: 0, lastRunning: null, restartAfter: 0 };
      this.devices.set(serial, state);
    }
    return state;
  }

  private humanActive(serial: string): boolean {
    const state = this.devices.get(serial);
    return !!state && Date.now() - state.lastHumanInputAt < HUMAN_IDLE_MS;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    this.refreshTriggers(now);

    const serials = new Set([...this.devices.keys(), ...this.store.list().map((s) => s.deviceSerial)]);
    for (const serial of serials) {
      const state = this.state(serial);
      const status = this.engine.status(serial);
      const running = status.state === "idle" ? null : status.scriptId;

      // A run that ended: drop one-shot activations, and give a persistent one
      // a breather so a script that finishes instantly can't spin. The breather
      // must NOT apply to one-shot work (a manual run, a daily firing) — that
      // would make pressing 執行 wait seconds for no reason.
      if (state.lastRunning && !running) {
        const activation = state.activations.get(state.lastRunning);
        if (activation?.oneShot) state.activations.delete(state.lastRunning);
        else state.restartAfter = Date.now() + RESTART_DELAY_MS;
      }
      state.lastRunning = running;

      if (this.humanActive(serial)) {
        if (running) this.engine.stop(serial); // yield the device; activation stays
        continue;
      }

      const desired = this.pick(state);
      if (running) {
        // Preempt only for something strictly better.
        const current = state.activations.get(running);
        if (desired && desired.scriptId !== running && desired.priority > (current?.priority ?? -Infinity)) {
          this.engine.stop(serial);
        }
        continue;
      }

      if (!desired) continue;
      // Only a persistent restart waits out the breather.
      if (!desired.oneShot && Date.now() < state.restartAfter) continue;
      const script = this.store.get(desired.scriptId);
      if (!script) {
        state.activations.delete(desired.scriptId);
        continue;
      }
      await this.engine.start(script).catch(() => {
        // Device busy or unreachable — try again next tick.
      });
    }
  }

  /** Activate persistent scripts, and daily ones whose time has come today. */
  private refreshTriggers(now: Date): void {
    const today = dayKey(now);
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const script of this.store.list()) {
      if (!script.enabled) {
        this.devices.get(script.deviceSerial)?.activations.delete(script.id);
        continue;
      }
      const state = this.state(script.deviceSerial);
      if (script.trigger.type === "persistent") {
        if (!state.activations.has(script.id)) {
          state.activations.set(script.id, { scriptId: script.id, priority: script.priority, oneShot: false, since: Date.now() });
        }
      } else if (script.trigger.type === "daily") {
        const [h, m] = script.trigger.time.split(":").map(Number);
        if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) continue;
        const key = `${script.id}@${today}`;
        if (minutes >= h * 60 + m && !this.firedDays.has(key)) {
          this.firedDays.add(key);
          state.activations.set(script.id, { scriptId: script.id, priority: script.priority, oneShot: true, since: Date.now() });
        }
      }
    }
  }

  /** Highest priority wins; ties go to whichever has been waiting longest. */
  private pick(state: DeviceState): Activation | undefined {
    let best: Activation | undefined;
    for (const activation of state.activations.values()) {
      if (!best || activation.priority > best.priority || (activation.priority === best.priority && activation.since < best.since)) {
        best = activation;
      }
    }
    return best;
  }
}
