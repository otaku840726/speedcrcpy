import { scriptMigrateSteps } from "@speedcrcpy/shared";
import type { Script } from "@speedcrcpy/shared";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Persisted automation scripts, keyed by id (see docs/automation-scripts.md). */
export class ScriptStore {
  private readonly path: string;
  private readonly scripts = new Map<string, Script>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "scripts.json");
    if (existsSync(this.path)) {
      try {
        const list = JSON.parse(readFileSync(this.path, "utf8")) as Script[];
        // Scripts saved before scheduling existed have no trigger/priority.
        for (const s of list) {
          this.scripts.set(s.id, {
            ...s,
            trigger: s.trigger ?? { type: "manual" },
            priority: s.priority ?? 20,
            enabled: s.enabled ?? true,
            steps: scriptMigrateSteps(s.steps ?? []),
          });
        }
      } catch {
        /* corrupt file — start empty */
      }
    }
  }

  list(serial?: string): Script[] {
    const all = [...this.scripts.values()];
    return serial ? all.filter((s) => s.deviceSerial === serial) : all;
  }

  get(id: string): Script | undefined {
    return this.scripts.get(id);
  }

  /** Create (no id) or update (existing id); returns the stored script. */
  save(script: Omit<Script, "id"> & { id?: string }): Script {
    const stored: Script = { ...script, id: script.id ?? randomUUID() };
    this.scripts.set(stored.id, stored);
    this.persist();
    return stored;
  }

  delete(id: string): boolean {
    const ok = this.scripts.delete(id);
    if (ok) this.persist();
    return ok;
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2));
  }
}
