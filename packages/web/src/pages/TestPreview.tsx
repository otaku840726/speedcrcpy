import {
  type ScriptCandidate,
  type ScriptFilter,
  type ScriptPick,
  type ScriptPickBy,
  type ScriptRegion,
  type ScriptTemplate,
  type ScriptTextMode,
  scriptSelect,
} from "@speedcrcpy/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/**
 * Configure a vision step against the frame it will run on.
 *
 * Every option here — which matches count, which one to act on — is meaningless
 * without seeing the candidates, so configuration and verification share one
 * screen rather than being a settings row plus a separate preview. The probe
 * returns candidates *unfiltered*; filtering runs client-side through the same
 * `scriptSelect` the engine uses, so the settings respond instantly without
 * another capture and the two can never disagree about the outcome.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OcrProbe {
  lines: (Box & { text: string; confidence: number })[];
  matches: (Box & { text: string; confidence: number; lineText?: string })[];
  text: string;
  ms: number;
  frameWidth: number;
  frameHeight: number;
  preview: string;
}

interface MatchProbe extends Box {
  score: number;
  confidence: number;
  matches: (Box & { score: number; confidence: number })[];
  ms: number;
  frameWidth: number;
  frameHeight: number;
  preview: string;
  crop: string;
  scaleMismatch: { captured: string; now: string } | null;
  suggestedThreshold: number;
}

export type TestTarget =
  | { kind: "ocr"; region?: ScriptRegion; text?: string }
  | { kind: "match"; region?: ScriptRegion; template: ScriptTemplate; threshold: number };

type Candidate = ScriptCandidate & { label: string };

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

const MODES: { value: ScriptTextMode; label: string; hint: string }[] = [
  { value: "contains", label: "包含", hint: "只要出現在辨識到的文字裡就算" },
  { value: "standalone", label: "前後無字", hint: "必須是獨立的一段,前後不能有其他字" },
  { value: "exact", label: "整行相符", hint: "整行辨識結果必須完全等於它" },
];

const ORDERS: { value: ScriptPickBy; label: string }[] = [
  { value: "reading", label: "由上而下" },
  { value: "left", label: "最左邊起" },
  { value: "right", label: "最右邊起" },
  { value: "top", label: "最上面起" },
  { value: "bottom", label: "最下面起" },
  { value: "score", label: "最像的起" },
  { value: "random", label: "隨機" },
];

const REASONS: Record<string, string> = { mode: "前後有字", confidence: "信心度不足" };

export function TestPreview({
  serial,
  target,
  filter,
  pick,
  onChange,
  onClose,
  onSuggestThreshold,
}: {
  serial: string;
  target: TestTarget;
  filter: ScriptFilter | undefined;
  pick: ScriptPick | undefined;
  /** Absent for the if-steps, which only ask whether anything matched and so
   * have no single target to configure. */
  onChange?: (filter: ScriptFilter, pick: ScriptPick) => void;
  onClose: () => void;
  onSuggestThreshold?: (value: number) => void;
}) {
  const [ocr, setOcr] = useState<OcrProbe>();
  const [match, setMatch] = useState<MatchProbe>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = () => {
    setBusy(true);
    setError(undefined);
    const path = target.kind === "ocr" ? "ocr" : "match";
    const body =
      target.kind === "ocr"
        ? { region: target.region, text: target.text }
        : { region: target.region, template: target.template, threshold: target.threshold };
    api<OcrProbe & MatchProbe>(`/api/devices/${encodeURIComponent(serial)}/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    })
      .then((r) => (target.kind === "ocr" ? setOcr(r) : setMatch(r)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "測試失敗"))
      .finally(() => setBusy(false));
  };
  useEffect(run, [serial]);

  const probe = ocr ?? match;
  const wanted = target.kind === "ocr" ? target.text : undefined;
  const set = (next: { filter?: ScriptFilter; pick?: ScriptPick }) =>
    onChange?.({ ...filter, ...next.filter }, { ...pick, ...next.pick });

  // Re-filtering is pure — no capture, no round trip — so dragging the
  // confidence slider redraws the boxes as fast as it moves.
  const candidates: Candidate[] = useMemo(
    () =>
      target.kind === "ocr"
        ? (ocr?.matches ?? []).map((m) => ({ ...m, label: m.text }))
        : (match?.matches ?? []).map((m) => ({ ...m, label: pct(m.score) })),
    [ocr, match, target.kind],
  );
  const selection = useMemo(() => scriptSelect(candidates, wanted, filter, pick), [candidates, wanted, filter, pick]);
  const chosen = selection.chosen;

  const boxStyle = (b: Box) => ({
    left: `${(b.x - b.w / 2) * 100}%`,
    top: `${(b.y - b.h / 2) * 100}%`,
    width: `${b.w * 100}%`,
    height: `${b.h * 100}%`,
  });

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker-box tp-box" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>
            {target.kind === "ocr" ? "依文字點擊 · 設定與測試" : "找圖 · 設定與測試"}
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
              綠色十字 = 實際會點擊的位置
            </span>
          </span>
          <button disabled={busy} onClick={run}>
            {busy ? "測試中…" : "重新測試"}
          </button>
          <button onClick={onClose}>關閉</button>
        </div>

        {error && <p className="error-text" style={{ padding: "8px 4px" }}>{error}</p>}
        {!probe && !error && <p className="muted" style={{ padding: "8px 4px" }}>正在抓取畫面…</p>}

        {probe && (
          <div className="tp-work">
            <div className="tp-stage">
              <img src={`data:image/png;base64,${probe.preview}`} alt="" />

              {target.region && <div className="tp-region" style={boxStyle(target.region)} />}

              {ocr?.lines.map((line, i) => (
                <div
                  key={i}
                  className="tp-box-outline"
                  style={boxStyle(line)}
                  title={`${line.text} · ${pct(line.confidence)}`}
                />
              ))}

              {/* Filtered out, but still drawn: a filter that removes matches
                  invisibly turns "找不到" into guesswork. */}
              {selection.rejected.map(({ candidate, reason }, i) => (
                <div key={`x${i}`} className="tp-box-outline tp-cand out" style={boxStyle(candidate)} title={REASONS[reason]}>
                  <span className="tp-cand-no">✕</span>
                </div>
              ))}

              {selection.kept.map((candidate, i) => (
                <div
                  key={i}
                  className={`tp-box-outline tp-cand${candidate === chosen ? " hit tp-refined" : ""}${onChange ? " pickable" : ""}`}
                  style={boxStyle(candidate)}
                  title={`第 ${i + 1} 個 · ${(candidate as Candidate).label}`}
                  onClick={onChange ? () => set({ pick: { index: i } }) : undefined}
                >
                  {selection.kept.length > 1 && <span className="tp-cand-no">{i + 1}</span>}
                </div>
              ))}

              {chosen && (
                <>
                  <div className="tp-cross" style={{ left: `${chosen.x * 100}%`, top: `${chosen.y * 100}%` }} />
                  <div
                    className={`tp-taplab${chosen.x > 0.5 ? " flip" : ""}`}
                    style={{ left: `${chosen.x * 100}%`, top: `${chosen.y * 100}%` }}
                  >
                    {Math.round(chosen.x * probe.frameWidth)},{Math.round(chosen.y * probe.frameHeight)}
                  </div>
                </>
              )}
            </div>

            {onChange && (
              <div className="tp-config">
                {target.kind === "ocr" && (
                  <div className="tp-group">
                    <h4>哪些算數</h4>
                    <div className="tp-line">
                      <span className="tp-key">比對</span>
                      {MODES.map((m) => (
                        <label key={m.value} title={m.hint}>
                          <input
                            type="radio"
                            checked={(filter?.mode ?? "contains") === m.value}
                            onChange={() => set({ filter: { mode: m.value } })}
                          />
                          {m.label}
                        </label>
                      ))}
                    </div>
                    <div className="tp-line">
                      <span className="tp-key">信心度</span>
                      <input
                        type="range"
                        min={0}
                        max={90}
                        step={10}
                        value={Math.round((filter?.minConfidence ?? 0) * 100)}
                        onChange={(e) => set({ filter: { minConfidence: Number(e.target.value) / 100 } })}
                      />
                      <span className="tp-val">≥ {Math.round((filter?.minConfidence ?? 0) * 100)}%</span>
                    </div>
                  </div>
                )}

                <div className="tp-group">
                  <h4>挑哪一個</h4>
                  <div className="tp-line">
                    <span className="tp-key">數量</span>
                    <label title="有幾個都行,照下面的順序取">
                      <input
                        type="radio"
                        checked={(pick?.expect ?? "any") === "any"}
                        onChange={() => set({ pick: { expect: "any" } })}
                      />
                      任意
                    </label>
                    <label title="超過一個就當作誤判,繼續等到畫面穩定">
                      <input type="radio" checked={pick?.expect === "one"} onChange={() => set({ pick: { expect: "one" } })} />
                      必須剛好 1 個
                    </label>
                  </div>
                  <div className="tp-line">
                    <span className="tp-key">排序</span>
                    <select value={pick?.by ?? "reading"} onChange={(e) => set({ pick: { by: e.target.value as ScriptPickBy } })}>
                      {ORDERS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <span className="muted">取第</span>
                    <input
                      className="sp-num"
                      value={(pick?.index ?? 0) + 1}
                      onChange={(e) => set({ pick: { index: Math.max(0, (Number(e.target.value) || 1) - 1) } })}
                    />
                    <span className="muted">個</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {probe && (
          <div className="tp-foot">
            <div>
              {selection.unsettled ? (
                <span className="tp-warn-inline">
                  ⚠ 符合 {selection.kept.length} 個,但設定為必須剛好 1 個 — 執行時會繼續等
                </span>
              ) : chosen ? (
                <span className="tp-ok">
                  ✓ 符合 {selection.kept.length} 個
                  {selection.rejected.length ? `,${selection.rejected.length} 個被濾掉` : ""} · 會點第{" "}
                  {selection.kept.indexOf(chosen) + 1} 個
                </span>
              ) : (
                <span className="error-text" style={{ display: "inline" }}>
                  ✕ 沒有可點的目標{selection.rejected.length ? `(${selection.rejected.length} 個被濾掉)` : ""}
                </span>
              )}
              <span className="muted"> · {probe.ms}ms · {probe.frameWidth}×{probe.frameHeight}</span>
            </div>

            {(selection.kept.length > 0 || selection.rejected.length > 0) && (
              <div className="tp-cands">
                {selection.kept.map((c, i) => (
                  <button
                    key={`k${i}`}
                    className={`tp-cand-row${c === chosen ? " sel" : ""}`}
                    disabled={!onChange}
                    onClick={() => set({ pick: { index: i } })}
                  >
                    <span className="tp-cand-no">{i + 1}</span>
                    <span className="tp-cand-text">{(c as Candidate).label}</span>
                    <span className="muted">{pct(c.confidence)}</span>
                    {c === chosen && <span className="tp-ok tp-cand-why">→ 會點這個</span>}
                  </button>
                ))}
                {selection.rejected.map(({ candidate, reason }, i) => (
                  <div key={`r${i}`} className="tp-cand-row out">
                    <span className="tp-cand-no">✕</span>
                    <span className="tp-cand-text">{candidate.text ?? (candidate as Candidate).label}</span>
                    <span className="muted">{pct(candidate.confidence)}</span>
                    <span className="tp-cand-why">{REASONS[reason]}</span>
                  </div>
                ))}
              </div>
            )}

            {ocr && (
              <div className="tp-read">
                <span className="muted">讀到:</span> {ocr.text || "(沒讀到文字)"}
              </div>
            )}

            {match && target.kind === "match" && (
              <div className="tp-cmp">
                <figure>
                  <img src={`data:image/png;base64,${target.template.png}`} alt="" />
                  <figcaption>模板</figcaption>
                </figure>
                <span className="tp-arrow">→</span>
                <figure>
                  <img className={chosen ? "hit" : ""} src={`data:image/png;base64,${match.crop}`} alt="" />
                  <figcaption>畫面上</figcaption>
                </figure>
                <div className="tp-bar">
                  <div className="tp-barline">
                    <div className={`tp-fill${chosen ? " hit" : ""}`} style={{ width: pct(match.score) }} />
                    <div className="tp-thr" style={{ left: pct(target.threshold) }} />
                  </div>
                  <div className="tp-score">
                    <span className={chosen ? "tp-ok" : "error-text"} style={{ display: "inline" }}>
                      最佳相似度 {pct(match.score)} · 門檻 {pct(target.threshold)}
                    </span>
                    {onSuggestThreshold && (
                      <button onClick={() => onSuggestThreshold(match.suggestedThreshold)}>
                        套用建議 {pct(match.suggestedThreshold)}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {match?.scaleMismatch && (
              <div className="tp-warn">
                ⚠ 模板擷取於 {match.scaleMismatch.captured},目前 {match.scaleMismatch.now} — 找圖不抗縮放,建議重新框選
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
