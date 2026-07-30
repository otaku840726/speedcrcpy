import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One in-progress edit, kept apart from the script it belongs to. */
export interface ScriptDraft {
  /** The script's id, or `new:<uuid>` for one that has never been saved. */
  key: string;
  /** Whatever the editor had on screen. Deliberately untyped: see below. */
  body: unknown;
  updatedAt: number;
}

/**
 * Edits in progress, so closing the panel to go and look at the game does not
 * throw away work — and so "saved" can mean something, since anything the store
 * holds is by definition not saved yet.
 *
 * Drafts are stored as-is and never validated against the script schema. A
 * half-finished step is the normal state of a draft: the name is still empty,
 * the text step has nothing to search for yet. Validation belongs at save time,
 * where refusing is useful; refusing to remember an edit is not. That also means
 * a draft is never runnable — a run always uses the saved script.
 *
 * Keyed by script, not by viewer: two browsers editing the same script share one
 * draft and the last write wins. For a tool driving your own phones that is the
 * behaviour you want (carry on from the desktop where the phone left off).
 */
export class DraftStore {
  private readonly path: string;
  private readonly drafts = new Map<string, ScriptDraft>();

  constructor(dataDir: string) {
    this.path = join(dataDir, "drafts.json");
    if (existsSync(this.path)) {
      try {
        for (const draft of JSON.parse(readFileSync(this.path, "utf8")) as ScriptDraft[]) {
          this.drafts.set(draft.key, draft);
        }
      } catch {
        /* corrupt file — start empty */
      }
    }
  }

  list(): ScriptDraft[] {
    return [...this.drafts.values()];
  }

  get(key: string): ScriptDraft | undefined {
    return this.drafts.get(key);
  }

  put(key: string, body: unknown, now: number): ScriptDraft {
    const draft: ScriptDraft = { key, body, updatedAt: now };
    this.drafts.set(key, draft);
    this.persist();
    return draft;
  }

  delete(key: string): boolean {
    const existed = this.drafts.delete(key);
    if (existed) this.persist();
    return existed;
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.list(), null, 2));
  }
}
