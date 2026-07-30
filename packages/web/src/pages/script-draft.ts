import type { Script, ScriptStep, ScriptTrigger } from "@speedcrcpy/shared";

/**
 * The editing side of a script: what is on screen, which is not necessarily
 * what is saved.
 *
 * `key` is how the draft is addressed server-side — the script's id, or a
 * `new:<uuid>` for one that has never been saved.
 */
export interface Draft {
  key: string;
  id?: string;
  name: string;
  steps: ScriptStep[];
  trigger: ScriptTrigger;
  priority: number;
  enabled: boolean;
  devices: string[];
}

/** What gets sent to the server, and what is compared against it. */
export const draftBody = (draft: Draft) => ({
  id: draft.id,
  name: draft.name,
  steps: draft.steps,
  trigger: draft.trigger,
  priority: draft.priority,
  enabled: draft.enabled,
  devices: draft.devices,
});

export const asDraft = (script: Script): Draft => ({
  key: script.id,
  id: script.id,
  name: script.name,
  steps: script.steps,
  trigger: script.trigger,
  priority: script.priority,
  enabled: script.enabled,
  devices: script.devices,
});

export const newDraft = (serial: string): Draft => ({
  key: `new:${crypto.randomUUID()}`,
  name: "新腳本",
  steps: [],
  trigger: { type: "manual" },
  priority: 20,
  enabled: true,
  devices: [serial],
});

/**
 * JSON with object keys sorted and `undefined` dropped, so two values that mean
 * the same thing produce the same string.
 *
 * Plain `JSON.stringify` compares key order too, and an edited step keeps a
 * different order from the one the server sends back — which would light up
 * "未儲存" on a script nobody touched. A badge that cries wolf is worse than no
 * badge, since the whole point is to be able to trust it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );
}

/** Is this draft the same as what is stored? A draft with no saved script
 * behind it (a new one) is always unsaved, even while it is still empty. */
export function isSaved(draft: Draft, stored: Script | undefined): boolean {
  if (!stored) return false;
  return stableJson(draftBody(draft)) === stableJson(draftBody(asDraft(stored)));
}
