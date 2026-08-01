import type { Script, ScriptRegion, ScriptTemplate, ScriptVariable } from "@speedcrcpy/shared";
import { Icon } from "../core/icons";
import { COMPARES, ValueField, VAR_TYPE_LABELS } from "./script-vars";

type CallStep = { type: "call"; scriptId: string; args: { param: string; value?: unknown; fromVar?: string }[]; outputs: { param: string; toVar: string }[] };
type IfVarStep = { type: "ifVar"; name: string; compare: string; value?: string | number; fromVar?: string };

/**
 * A call to another script, shown as what goes in and what comes out.
 *
 * The module's own declaration drives the whole row: each `in` variable becomes
 * a field of the right kind, each `out` becomes a place to put the result. Add
 * a parameter to the module and it appears here; there is no second list to
 * keep in step with the first.
 */
export function CallStepBody({
  step,
  modules,
  onChange,
  onEdit,
  editing,
  pickTemplate,
  pickRegion,
  callerVars,
  compact,
}: {
  step: CallStep;
  modules: Script[];
  onChange: (patch: Partial<CallStep>) => void;
  onEdit: () => void;
  editing: boolean;
  pickTemplate: (apply: (t: ScriptTemplate) => void) => void;
  pickRegion: (apply: (r: ScriptRegion) => void) => void;
  callerVars: ScriptVariable[];
  /** Folded: say which module and how much it is wired to, nothing else. */
  compact?: boolean;
}) {
  const module = modules.find((m) => m.id === step.scriptId);
  const inputs = (module?.variables ?? []).filter((v) => v.kind === "in");
  const outputs = (module?.variables ?? []).filter((v) => v.kind === "out");
  const argOf = (name: string) => step.args.find((a) => a.param === name);
  const setArg = (name: string, patch: { value?: unknown; fromVar?: string }) =>
    onChange({
      args: [...step.args.filter((a) => a.param !== name), { param: name, ...argOf(name), ...patch }],
    });

  if (compact) {
    return (
      <>
        <Icon name="package" size={14} />
        <span className="sp-module-name">{module?.name ?? "(未選模組)"}</span>
        <span className="sp-summary">
          {module ? `${module.steps.length} 步` : ""}
          {inputs.length ? ` · 入 ${inputs.length}` : ""}
          {step.outputs.length ? ` · 出 ${step.outputs.map((o) => o.toVar).join("、")}` : ""}
        </span>
      </>
    );
  }

  return (
    <>
      <Icon name="package" size={14} />
      <select className="sp-module" value={step.scriptId} onChange={(e) => onChange({ scriptId: e.target.value, args: [], outputs: [] })}>
        <option value="">— 選擇模組 —</option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>{m.name}</option>
        ))}
      </select>
      {module ? (
        <>
          <span className="muted">{module.steps.length} 步</span>
          <button className={editing ? "on" : ""} title="就地編輯這個模組" onClick={onEdit}>
            <Icon name="pencil" size={12} />
          </button>
        </>
      ) : (
        <span className="sp-warn-inline">尚未選擇模組</span>
      )}

      {inputs.map((v) => {
        const arg = argOf(v.name);
        // A value can be typed in, or taken from a variable of the same type —
        // which is how a module gets something the caller only learns at run time.
        const sources = callerVars.filter((c) => c.type === v.type);
        return (
          <span className="sp-arg" key={v.name}>
            <span className="muted">{v.name}</span>
            {arg?.fromVar ? (
              <select value={arg.fromVar} onChange={(e) => setArg(v.name, { fromVar: e.target.value || undefined, value: undefined })}>
                <option value="">(改填固定值)</option>
                {sources.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
            ) : (
              <ValueField
                type={v.type}
                value={arg?.value as never}
                onChange={(value) => setArg(v.name, { value, fromVar: undefined })}
                pickTemplate={pickTemplate}
                pickRegion={pickRegion}
              />
            )}
            {!!sources.length && (
              <button
                className={arg?.fromVar ? "on" : ""}
                title={arg?.fromVar ? "改成固定值" : "改成用變數"}
                onClick={() => setArg(v.name, arg?.fromVar ? { fromVar: undefined } : { fromVar: sources[0]!.name, value: undefined })}
              >
                <Icon name="variable" size={12} />
              </button>
            )}
          </span>
        );
      })}

      {outputs.map((v) => {
        const bound = step.outputs.find((o) => o.param === v.name);
        return (
          <span className="sp-arg out" key={v.name}>
            <span className="muted">{v.name} →</span>
            <select
              value={bound?.toVar ?? ""}
              onChange={(e) =>
                onChange({
                  outputs: [
                    ...step.outputs.filter((o) => o.param !== v.name),
                    ...(e.target.value ? [{ param: v.name, toVar: e.target.value }] : []),
                  ],
                })
              }
            >
              <option value="">(不接收)</option>
              {callerVars.filter((c) => c.type === v.type).map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <span className="muted">{VAR_TYPE_LABELS[v.type]}</span>
          </span>
        );
      })}
    </>
  );
}

/** Ask about a variable. The operators offered come from its declared type. */
export function IfVarBody({
  step,
  variables,
  onChange,
}: {
  step: IfVarStep;
  variables: ScriptVariable[];
  onChange: (patch: Partial<IfVarStep>) => void;
}) {
  const variable = variables.find((v) => v.name === step.name);
  const options = variable ? COMPARES[variable.type] : [];
  const chosen = options.find((o) => o.value === step.compare);
  const sources = variables.filter((v) => v.name !== step.name && v.type === variable?.type);

  return (
    <>
      若變數
      <select
        value={step.name}
        onChange={(e) => {
          const next = variables.find((v) => v.name === e.target.value);
          // The old operator may not exist for the new type, so take the first
          // one that does rather than leaving an impossible pairing on screen.
          onChange({ name: e.target.value, compare: next ? COMPARES[next.type][0]?.value : undefined });
        }}
      >
        <option value="">— 選變數 —</option>
        {variables.map((v) => (
          <option key={v.name} value={v.name}>{v.name}</option>
        ))}
      </select>
      {!variable ? (
        <span className="sp-warn-inline">先在上面宣告一個變數</span>
      ) : (
        <>
          <select value={step.compare} onChange={(e) => onChange({ compare: e.target.value })}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {chosen?.needsValue &&
            (step.fromVar ? (
              <select value={step.fromVar} onChange={(e) => onChange({ fromVar: e.target.value || undefined })}>
                <option value="">(改填固定值)</option>
                {sources.map((v) => (
                  <option key={v.name} value={v.name}>{v.name}</option>
                ))}
              </select>
            ) : (
              <input
                className={variable.type === "number" ? "sp-num" : "sp-text"}
                value={String(step.value ?? "")}
                onChange={(e) =>
                  onChange({ value: variable.type === "number" ? Number(e.target.value) || 0 : e.target.value })
                }
              />
            ))}
          {chosen?.needsValue && !!sources.length && (
            <button
              className={step.fromVar ? "on" : ""}
              title={step.fromVar ? "改成固定值" : "改成比對另一個變數"}
              onClick={() => onChange(step.fromVar ? { fromVar: undefined } : { fromVar: sources[0]!.name, value: undefined })}
            >
              <Icon name="variable" size={12} />
            </button>
          )}
        </>
      )}
    </>
  );
}
