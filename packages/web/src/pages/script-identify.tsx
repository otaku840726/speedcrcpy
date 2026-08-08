import type { IdentifyCase, ScriptRegion, ScriptTemplate, ScriptVariable } from "@speedcrcpy/shared";
import { useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";

interface Probe {
  ms: number;
  /** Which case won, by position. A case being tested may not be named yet. */
  winnerIndex: number | null;
  results: {
    name: string;
    score: number;
    passed: boolean;
    crop: string;
    suggestedThreshold: number;
    scaleMismatch: { captured: string; now: string } | null;
  }[];
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

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
  serial,
  variables,
  onChange,
  pickTemplate,
  pickRegion,
  compact,
}: {
  step: IdentifyStep;
  serial: string;
  variables: ScriptVariable[];
  onChange: (patch: Partial<IdentifyStep>) => void;
  pickTemplate: (apply: (t: ScriptTemplate) => void) => void;
  pickRegion: (apply: (r: ScriptRegion) => void) => void;
  /** Folded: how many pictures and where the answer goes, nothing else. */
  compact?: boolean;
}) {
  const [probe, setProbe] = useState<Probe>();
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string>();

  const editCase = (i: number, patch: Partial<IdentifyCase>) =>
    onChange({ cases: step.cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const test = () => {
    setTesting(true);
    setError(undefined);
    api<Probe>(`/api/devices/${encodeURIComponent(serial)}/identify`, {
      method: "POST",
      body: JSON.stringify({ cases: step.cases }),
    })
      .then(setProbe)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "測試失敗"))
      .finally(() => setTesting(false));
  };

  if (compact) {
    return (
      <>
        辨識情境
        <span className="sp-summary">
          {step.cases.length} 張
          {step.cases.length ? ` · ${step.cases.map((c) => `${c.name || "?"}${c.tap ? "(點)" : ""}`).join("、")}` : ""}
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
            {/* The name is this step's output — 若變數 branches on it — so the
                server refuses to save a case without one. Say so here rather
                than at save time, where a 400 arrives after the work. */}
            <input
              className={one.name ? "sp-case-name" : "sp-case-name warn"}
              value={one.name}
              placeholder="叫什麼"
              title={one.name ? "" : "還沒取名字 — 這是存進變數的值,沒有它存不了檔"}
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
            {/* Recognising a popup is usually a prelude to dismissing it, and
                doing that through a branch would look for the same picture on a
                second capture — the slow half again, against a screen that has
                had time to move. */}
            <label className="sp-case-tap" title="命中這一張時,直接點擊它">
              <input type="checkbox" checked={!!one.tap} onChange={(e) => editCase(i, { tap: e.target.checked || undefined })} />
              點擊
            </label>
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
        <button
          className="sp-probe"
          disabled={testing || !step.cases.some((c) => c.template.png)}
          title={step.cases.some((c) => c.template.png) ? "看這一步現在會判成哪個" : "請先框選圖像"}
          onClick={test}
        >
          {testing ? "比對中…" : "測試"}
        </button>
        {error && <span className="sp-warn-inline">{error}</span>}
        {probe && (
          <div className="sp-verdict">
            <div className="sp-verdict-head">
              {probe.winnerIndex !== null ? (
                <>
                  現在判為 <b>{probe.results[probe.winnerIndex]?.name || `第 ${probe.winnerIndex + 1} 張`}</b>
                  {/* The probe never taps — a test with side effects is not a
                      test. Say what the run would do instead. */}
                  {step.cases[probe.winnerIndex]?.tap && (
                    <span className="muted"> · 執行時會點擊它(測試不會)</span>
                  )}
                  {!probe.results[probe.winnerIndex]?.name && (
                    <span className="sp-warn-inline"> · 這一張還沒取名字,存檔會被擋下</span>
                  )}
                </>
              ) : (
                <span className="sp-warn-inline">現在沒有一張達到自己的門檻</span>
              )}
              <span className="muted"> · {probe.ms} ms</span>
            </div>
            {/* Every score, not just the winner's: the failure this step has is
                two pictures matching at once, and you can only see that coming
                by reading the runner-up. */}
            {probe.results.map((r, i) => (
              <div className={`sp-verdict-row${i === probe.winnerIndex ? " won" : ""}`} key={i}>
                <img src={`data:image/png;base64,${r.crop}`} alt="" />
                <span className="sp-verdict-name">{r.name || `(第 ${i + 1} 張)`}</span>
                <span className={r.passed ? "sp-ok" : "muted"}>
                  {pct(r.score)} / 門檻 {pct(step.cases[i]?.threshold ?? 0)}
                </span>
                {r.scaleMismatch && (
                  <span className="sp-warn-inline">
                    截取時 {r.scaleMismatch.captured},現在 {r.scaleMismatch.now}
                  </span>
                )}
                <button
                  title="把這一張的門檻設成略低於剛才的分數"
                  onClick={() => editCase(i, { threshold: r.suggestedThreshold })}
                >
                  套用 {pct(r.suggestedThreshold)}
                </button>
              </div>
            ))}
          </div>
        )}
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
      {step.cases.some((c) => !c.name) && (
        <span className="sp-warn-inline">有情境還沒取名字 — 存檔會被擋下</span>
      )}
    </>
  );
}
