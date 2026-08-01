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
  /**
   * Scripts the user stopped by hand, held off until they ask for them again.
   *
   * Without this, `停止` on a persistent script lasts about three seconds: the
   * next tick re-activates it because it is still enabled, and it starts over
   * with the log cheerfully reading 已停止. Runtime state on purpose — stopping
   * a script for now should not rewrite what the script is configured to do.
   */
  suppressed: Set<string>;
  lastHumanInputAt: number;
  /** Script the engine was last seen running, to detect completion. */
  lastRunning: string | null;
  /** Earliest time a persistent script may restart after finishing. */
  restartAfter: number;
  /** Set when the engine could not start on this device — almost always the
   * device being unreachable. Without it, pressing 執行 on a disconnected phone
   * does nothing at all and says nothing about why. */
  unreachable: boolean;
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

  /** Queue a script to run now on `serial`, outranking scheduled work. A manual
   * run targets the device you asked from, not the script's scheduled list. */
  requestRun(script: Script, serial: string): void {
    const state = this.state(serial);
    state.suppressed.delete(script.id); // asking for it is how a stop is undone
    state.activations.set(script.id, {
      scriptId: script.id,
      priority: script.priority + MANUAL_BOOST,
      oneShot: true,
      since: Date.now(),
    });
    void this.tick().catch(() => {});
  }

  /**
   * Stop whatever holds the device, clear what was about to take it, and keep
   * all of it off until asked again.
   *
   * Everything currently wanting the device is suppressed, not just the one
   * that happens to be running — otherwise stopping a script only hands the
   * device to the next one in the queue, which is not what the button says. A
   * daily script whose time has not come yet is untouched, since it has no
   * activation to suppress.
   */
  cancel(serial: string): void {
    const state = this.state(serial);
    for (const scriptId of state.activations.keys()) state.suppressed.add(scriptId);
    state.activations.clear();
    this.engine.stop(serial);
  }

  /** Let a stopped script be scheduled again — used when it is re-enabled. */
  resume(scriptId: string, serial: string): void {
    this.state(serial).suppressed.delete(scriptId);
  }

  /**
   * The script queued for a device but not yet running, and why — so the UI can
   * say "queued" / "you're touching the device" instead of looking dead.
   */
  pending(serial: string): { scriptId: string; reason: ScriptPendingReason } | null {
    const state = this.devices.get(serial);
    if (!state) return null;

    const status = this.engine.status(serial);
    const running = status.state === "idle" ? null : status.scriptId;
    // The best activation that is NOT the one already running — otherwise a
    // script queued behind a running one would never be reported.
    const desired = this.pick(state, running);
    if (!desired) return null;

    if (state.unreachable && !running) return { scriptId: desired.scriptId, reason: "unreachable" };
    if (this.humanActive(serial)) return { scriptId: desired.scriptId, reason: "humanActive" };
    if (running) return { scriptId: desired.scriptId, reason: "outranked" };
    return { scriptId: desired.scriptId, reason: "queued" };
  }

  overview(): DeviceSchedule[] {
    const now = new Date();
    const bySerial = new Map<string, ScheduleScript[]>();
    // A script can be scheduled on several devices, so it appears under each.
    for (const script of this.store.list()) {
      if (script.isModule) continue;
      for (const serial of script.devices) {
      const state = this.devices.get(serial);
      const running = this.engine.status(serial);
      const isRunning = running.scriptId === script.id && running.state !== "idle";
      const waiting = state?.activations.has(script.id) ?? false;
      const list = bySerial.get(serial) ?? [];
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
      bySerial.set(serial, list);
      }
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
      state = { activations: new Map(), suppressed: new Set(), lastHumanInputAt: 0, lastRunning: null, restartAfter: 0, unreachable: false };
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

    const serials = new Set([...this.devices.keys(), ...this.store.list().flatMap((s) => s.devices)]);
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
      // Keep the activation on failure so it starts as soon as the device comes
      // back, but remember that it failed so the UI can say why nothing happens.
      await this.engine
        .start(script, serial)
        .then(() => {
          state.unreachable = false;
        })
        .catch(() => {
          state.unreachable = true;
        });
    }
  }

  /** Activate persistent scripts, and daily ones whose time has come today. */
  private refreshTriggers(now: Date): void {
    const today = dayKey(now);
    const minutes = now.getHours() * 60 + now.getMinutes();
    for (const script of this.store.list()) {
      // A module runs because something called it. Letting one activate on its
      // own would run it outside any caller, with no arguments and nowhere to
      // return anything to.
      if (script.isModule) continue;
      if (!script.enabled) {
        for (const serial of script.devices) this.devices.get(serial)?.activations.delete(script.id);
        continue;
      }
      for (const serial of script.devices) {
      const state = this.state(serial);
      if (script.trigger.type === "persistent") {
        // A stopped persistent script stays stopped; `firedDays` already keeps
        // a daily one from re-firing, so only this branch needs the check.
        if (!state.activations.has(script.id) && !state.suppressed.has(script.id)) {
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
  }

  /** Highest priority wins; ties go to whichever has been waiting longest.
   * `exclude` skips a script (used to find what is queued *behind* a run). */
  private pick(state: DeviceState, exclude?: string | null): Activation | undefined {
    let best: Activation | undefined;
    for (const activation of state.activations.values()) {
      if (exclude && activation.scriptId === exclude) continue;
      if (!best || activation.priority > best.priority || (activation.priority === best.priority && activation.since < best.since)) {
        best = activation;
      }
    }
    return best;
  }
}
