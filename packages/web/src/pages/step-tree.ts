import type { ScriptStep } from "@speedcrcpy/shared";

/**
 * Immutable edits on a script's step tree.
 *
 * Kept apart from the editor that calls them: nothing here touches React, so
 * the traversal can be exercised on its own. Paste is the operation that makes
 * that worth doing — an off-by-one puts the step next to where you meant.
 */

/** Where a step lives in the (nested) tree: child indexes plus which branch. */
export type Path = { index: number; branch?: "body" | "then" | "else" }[];

export type Branch = "body" | "then" | "else";

export function childrenOf(step: ScriptStep, branch: Branch): ScriptStep[] {
  const anyStep = step as unknown as Record<string, ScriptStep[] | undefined>;
  return anyStep[branch] ?? [];
}

export function withChildren(step: ScriptStep, branch: Branch, children: ScriptStep[]): ScriptStep {
  return { ...step, [branch]: children } as ScriptStep;
}

/**
 * Apply `edit` to the child list that `path` points into.
 *
 * A path ending in a row (no `branch`) hands `edit` that row's index; a path
 * ending in a branch means "this whole child list" and hands it -1, since there
 * is no row to point at. Only `appendTo` is meant for the second shape.
 */
export function editList(
  steps: ScriptStep[],
  path: Path,
  edit: (list: ScriptStep[], index: number) => ScriptStep[],
): ScriptStep[] {
  const [head, ...rest] = path;
  if (!head) return steps;
  if (rest.length === 0 && !head.branch) return edit(steps, head.index);
  const branch = head.branch ?? "body";
  return steps.map((step, i) => {
    if (i !== head.index) return step;
    const kids = childrenOf(step, branch);
    return withChildren(step, branch, rest.length === 0 ? edit(kids, -1) : editList(kids, rest, edit));
  });
}

/** Re-target a step's path at one of its branches, so edits land in that child list. */
export const intoBranch = (path: Path, branch: Branch): Path => [
  ...path.slice(0, -1),
  { index: path[path.length - 1]!.index, branch },
];

export const replaceAt = (next: ScriptStep) => (list: ScriptStep[], i: number) =>
  list.map((s, j) => (j === i ? next : s));
export const removeAt = () => (list: ScriptStep[], i: number) => list.filter((_, j) => j !== i);
export const appendTo = (step: ScriptStep) => (list: ScriptStep[]) => [...list, step];
export const moveAt = (dir: -1 | 1) => (list: ScriptStep[], i: number) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

/**
 * Paste below the row `path` points at. Row paths only: given a branch path's
 * -1 this would insert at the head of the list, which is not what "paste at the
 * end of this branch" means — that is `appendTo`.
 */
export const insertAfter = (step: ScriptStep) => (list: ScriptStep[], i: number) => [
  ...list.slice(0, i + 1),
  step,
  ...list.slice(i + 1),
];

/**
 * The step names a jump written at `path` is allowed to aim at: every label on
 * its own list, and on every list enclosing it.
 *
 * Not the ones nested inside branches it does not sit in — landing there would
 * mean entering a branch that was never taken, or a loop body from outside it.
 */
export function labelsInScope(steps: ScriptStep[], path: Path): string[] {
  const found: string[] = [];
  let list = steps;
  for (const hop of path) {
    for (const step of list) if (step.label) found.push(step.label);
    if (!hop.branch) break;
    list = childrenOf(list[hop.index] ?? ({} as ScriptStep), hop.branch);
  }
  return [...new Set(found)];
}

/** Is the step at `path` inside a 重複? Decides whether leaving a loop, or
 * skipping to its next pass, is something it can ask for. */
export function insideLoop(steps: ScriptStep[], path: Path): boolean {
  let list = steps;
  for (const hop of path) {
    const step = list[hop.index];
    if (!step || !hop.branch) break;
    if (step.type === "loop") return true;
    list = childrenOf(step, hop.branch);
  }
  return false;
}
