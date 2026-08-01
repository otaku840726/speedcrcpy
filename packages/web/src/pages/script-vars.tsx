import type { Script, ScriptRegion, ScriptTemplate, ScriptVarType, ScriptVariable } from "@speedcrcpy/shared";
import { Icon } from "../core/icons";

export const VAR_TYPE_LABELS: Record<ScriptVarType, string> = {
  number: "數字",
  text: "文字",
  boolean: "布林",
  image: "圖像",
  region: "範圍",
};

export const VAR_KIND_LABELS: Record<ScriptVariable["kind"], string> = {
  in: "入參",
  out: "出參",
  local: "內部",
};

/**
 * Which comparisons make sense for which type.
 *
 * The list is the point: a text variable never offers `>`, so there is no way
 * to write a comparison that reads sensibly and then behaves oddly at run time.
 */
export const COMPARES: Record<ScriptVarType, { value: string; label: string; needsValue: boolean }[]> = {
  number: [
    { value: ">", label: ">", needsValue: true },
    { value: ">=", label: "≥", needsValue: true },
    { value: "<", label: "<", needsValue: true },
    { value: "<=", label: "≤", needsValue: true },
    { value: "==", label: "=", needsValue: true },
    { value: "!=", label: "≠", needsValue: true },
  ],
  text: [
    { value: "==", label: "等於", needsValue: true },
    { value: "!=", label: "不等於", needsValue: true },
    { value: "contains", label: "包含", needsValue: true },
  ],
  boolean: [
    { value: "isTrue", label: "為真", needsValue: false },
    { value: "isFalse", label: "為假", needsValue: false },
  ],
  // A picture or a rectangle is something a step uses, not something a branch
  // asks about — offering a comparison here would only invite a wrong one.
  image: [],
  region: [],
};

/** Variables a step can write into, given what that step produces. */
export const varsOfType = (script: Pick<Script, "variables">, type: ScriptVarType): ScriptVariable[] =>
  (script.variables ?? []).filter((v) => v.type === type);

/**
 * What a script takes, returns, and keeps.
 *
 * Sits above the steps because it is the contract: reading it tells you how to
 * call this module without reading a single step.
 */
export function VariablesPanel({
  variables,
  onChange,
  isModule,
}: {
  variables: ScriptVariable[];
  onChange: (next: ScriptVariable[]) => void;
  isModule: boolean;
}) {
  const set = (i: number, patch: Partial<ScriptVariable>) =>
    onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <div className="sp-vars">
      <div className="sp-vars-head">
        <Icon name="variable" size={13} />
        變數
        <span style={{ flex: 1 }} />
        <button
          onClick={() =>
            onChange([...variables, { name: `變數${variables.length + 1}`, type: "number", kind: isModule ? "in" : "local" }])
          }
        >
          <Icon name="plus" size={12} /> 新增
        </button>
      </div>
      {!variables.length && (
        <span className="muted">
          {isModule ? "沒有宣告任何參數 — 這個模組不吃輸入,也不回傳東西" : "沒有變數 — 步驟讀到的值會用完就丟"}
        </span>
      )}
      {variables.map((v, i) => (
        <div className="sp-var" key={i}>
          <select value={v.kind} onChange={(e) => set(i, { kind: e.target.value as ScriptVariable["kind"] })}>
            {(["in", "out", "local"] as const).map((k) => (
              <option key={k} value={k}>{VAR_KIND_LABELS[k]}</option>
            ))}
          </select>
          <input
            className="sp-var-name"
            value={v.name}
            onChange={(e) => set(i, { name: e.target.value })}
            placeholder="名稱"
          />
          <select
            value={v.type}
            onChange={(e) => set(i, { type: e.target.value as ScriptVarType, default: undefined })}
          >
            {(Object.keys(VAR_TYPE_LABELS) as ScriptVarType[]).map((t) => (
              <option key={t} value={t}>{VAR_TYPE_LABELS[t]}</option>
            ))}
          </select>
          {/* Only an input can have a default: an output is whatever the run
              put there, and a local starts empty by definition. */}
          {v.kind === "in" && (v.type === "number" || v.type === "text") && (
            <input
              className="sp-var-default"
              value={String(v.default ?? "")}
              onChange={(e) => set(i, { default: v.type === "number" ? Number(e.target.value) || 0 : e.target.value })}
              placeholder="預設"
            />
          )}
          {v.kind === "in" && v.type === "boolean" && (
            <label className="sp-var-default">
              <input type="checkbox" checked={v.default === true} onChange={(e) => set(i, { default: e.target.checked })} />
              預設為真
            </label>
          )}
          <button title="刪除變數" onClick={() => onChange(variables.filter((_, j) => j !== i))}>
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The value side of an argument or a default — the control follows the type. */
export function ValueField({
  type,
  value,
  onChange,
  pickTemplate,
  pickRegion,
}: {
  type: ScriptVarType;
  value: string | number | boolean | ScriptTemplate | ScriptRegion | undefined;
  onChange: (value: string | number | boolean | ScriptTemplate | ScriptRegion | undefined) => void;
  pickTemplate: (apply: (t: ScriptTemplate) => void) => void;
  pickRegion: (apply: (r: ScriptRegion) => void) => void;
}) {
  if (type === "boolean") {
    return (
      <label className="sp-arg-bool">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        真
      </label>
    );
  }
  if (type === "image") {
    const template = value as ScriptTemplate | undefined;
    return (
      <button className="sp-tmpl" title="框選圖像" onClick={() => pickTemplate((t) => onChange(t))}>
        {template?.png ? <img src={`data:image/png;base64,${template.png}`} alt="" /> : <Icon name="image" size={16} />}
      </button>
    );
  }
  if (type === "region") {
    const region = value as ScriptRegion | undefined;
    return (
      <button className="sp-pick" title="框選範圍" onClick={() => pickRegion((r) => onChange(r))}>
        <Icon name="crosshair" size={13} />
        {region ? `${(region.w * 100).toFixed(0)}×${(region.h * 100).toFixed(0)}%` : "整張"}
      </button>
    );
  }
  return (
    <input
      className={type === "number" ? "sp-num" : "sp-text"}
      value={String(value ?? "")}
      onChange={(e) => onChange(type === "number" ? Number(e.target.value) || 0 : e.target.value)}
      placeholder={type === "number" ? "數值" : "文字"}
    />
  );
}
