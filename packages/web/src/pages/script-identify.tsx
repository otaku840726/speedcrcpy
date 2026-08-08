import type { IdentifyCase, ScriptRegion, ScriptTemplate, ScriptVariable } from "@speedcrcpy/shared";
import { Icon } from "../core/icons";

type IdentifyStep = {
  type: "identify";
  cases: IdentifyCase[];
  timeoutMs: number;
  saveTo?: string;
  saveX?: string;
  saveY?: string;
};

/**
 * "Which of these is on screen right now."
 *
 * The list is the step. Asking the same question with a chain of 找圖 steps
 * costs a ~350 ms capture each and answers about a different moment every time;
 * here one capture is matched against every picture, so the answer describes a
 * single instant and takes as long as one of them used to.
 *
 * Each row carries its own threshold and search area because the pictures are
 * not alike: a distinctive banner is safe at 80% over the whole screen, while a
 * plain button needs 92% and a box drawn around where it actually appears.
 */
export function IdentifyBody({
  step,
  variables,
  onChange,
  pickTemplate,
  pickRegion,
  compact,
}: {
  step: IdentifyStep;
  variables: ScriptVariable[];
  onChange: (patch: Partial<IdentifyStep>) => void;
  pickTemplate: (apply: (t: ScriptTemplate) => void) => void;
  pickRegion: (apply: (r: ScriptRegion) => void) => void;
  /** Folded: how many pictures and where the answer goes, nothing else. */
  compact?: boolean;
}) {
  const editCase = (i: number, patch: Partial<IdentifyCase>) =>
    onChange({ cases: step.cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  if (compact) {
    return (
      <>
        辨識情境
        <span className="sp-summary">
          {step.cases.length} 張
          {step.cases.length ? ` · ${step.cases.map((c) => c.name || "?").join("、")}` : ""}
          {step.saveTo ? ` → ${step.saveTo}` : ""}
        </span>
      </>
    );
  }

  const named = (type: ScriptVariable["type"]) => variables.filter((v) => v.type === type);

  return (
    <>
      辨識情境
      <div className="sp-cases">
        {step.cases.map((one, i) => (
          <div className="sp-case" key={i}>
            <button
              className="sp-tmpl"
              title="框選這個情境的特徵圖像"
              onClick={() => pickTemplate((template) => editCase(i, { template }))}
            >
              {one.template.png ? (
                <img src={`data:image/png;base64,${one.template.png}`} alt="" />
              ) : (
                <Icon name="image" size={16} />
              )}
            </button>
            <input
              className="sp-case-name"
              value={one.name}
              placeholder="叫什麼"
              onChange={(e) => editCase(i, { name: e.target.value })}
            />
            <input
              className="sp-num"
              value={Math.round(one.threshold * 100)}
              onChange={(e) => editCase(i, { threshold: (Number(e.target.value) || 0) / 100 })}
            />
            %
            <button
              className={`sp-pick${one.region ? "" : " warn"}`}
              title={one.region ? "重新框選搜尋範圍" : "未框選範圍:整張畫面(比對慢約 30 倍)"}
              onClick={() => pickRegion((region) => editCase(i, { region }))}
            >
              <Icon name="crosshair" size={13} />
              {one.region ? `${(one.region.w * 100).toFixed(0)}×${(one.region.h * 100).toFixed(0)}%` : "整張"}
            </button>
            <button
              className="sp-case-del"
              title="移除這一張"
              onClick={() => onChange({ cases: step.cases.filter((_, j) => j !== i) })}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        <button
          className="sp-add-btn"
          onClick={() =>
            onChange({
              cases: [
                ...step.cases,
                { name: "", template: { png: "", capturedWidth: 0, capturedHeight: 0 }, threshold: 0.85 },
              ],
            })
          }
        >
          <Icon name="plus" size={12} /> 新增一張
        </button>
      </div>
      逾時
      <input
        className="sp-num"
        value={step.timeoutMs}
        onChange={(e) => onChange({ timeoutMs: Number(e.target.value) || 0 })}
      />
      ms
      {/* The answer has to land somewhere to be worth having: the name goes to a
          text variable that 若變數 then branches on, and the position to number
          variables, so the branch can tap what was found without capturing the
          screen a second time. */}
      <span className="sp-arg out">
        <span className="muted">結果 →</span>
        <select value={step.saveTo ?? ""} onChange={(e) => onChange({ saveTo: e.target.value || undefined })}>
          <option value="">(不接收)</option>
          {named("text").map((v) => (
            <option key={v.name} value={v.name}>{v.name}</option>
          ))}
        </select>
      </span>
      <span className="sp-arg out">
        <span className="muted">座標 →</span>
        <select value={step.saveX ?? ""} onChange={(e) => onChange({ saveX: e.target.value || undefined })}>
          <option value="">(x 不接收)</option>
          {named("number").map((v) => (
            <option key={v.name} value={v.name}>{v.name}</option>
          ))}
        </select>
        <select value={step.saveY ?? ""} onChange={(e) => onChange({ saveY: e.target.value || undefined })}>
          <option value="">(y 不接收)</option>
          {named("number").map((v) => (
            <option key={v.name} value={v.name}>{v.name}</option>
          ))}
        </select>
      </span>
      {!named("text").length && <span className="sp-warn-inline">先在上面宣告一個文字變數來接結果</span>}
    </>
  );
}
