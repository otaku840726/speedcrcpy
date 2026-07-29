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
  matches: (Box & { text: string; confidence: number; lineText?: string; color?: string })[];
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
  { value: "nearest", label: "離參考點最近" },
  { value: "farthest", label: "離參考點最遠" },
  { value: "random", label: "隨機" },
];

/** Orders that measure from a point, and so need one to be set. */
const NEEDS_REF = new Set<ScriptPickBy>(["nearest", "farthest"]);

const REASONS: Record<string, string> = {
  mode: "前後有字",
  confidence: "信心度不足",
  color: "顏色不符",
  height: "字太大或太小",
};

/** The measured colour of a candidate's glyphs, and a one-click way to make it
 * the filter — picking a hex value by hand is guesswork, picking the colour of
 * something already on screen is not. */
function Swatch({ color, onPick }: { color?: string; onPick?: (hex: string) => void }) {
  if (!color) return null;
  return (
    <button
      className="tp-swatch"
      style={{ background: color }}
      title={onPick ? `${color} — 點擊改用這個顏色過濾` : color}
      disabled={!onPick}
      onClick={onPick ? (e) => (e.stopPropagation(), onPick(color)) : undefined}
    />
  );
}

export function TestPreview({
  serial,
  target,
  filter,
  pick,
  onChange,
  offset,
  onOffsetChange,
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
  /** Where the tap lands relative to the match, normalized. */
  offset?: { x: number; y: number };
  onOffsetChange?: (offset: { x: number; y: number } | undefined) => void;
  onClose: () => void;
  onSuggestThreshold?: (value: number) => void;
}) {
  const [ocr, setOcr] = useState<OcrProbe>();
  const [match, setMatch] = useState<MatchProbe>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** Armed by a 在畫面上點選 button: the next click on the picture sets that
   * value instead of selecting a candidate. */
  const [arming, setArming] = useState<"ref" | "offset">();

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
        : (match?.matches ?? []).map((m) => ({
            ...m,
            label: `${Math.round(m.x * (match?.frameWidth ?? 1))},${Math.round(m.y * (match?.frameHeight ?? 1))}`,
          })),
    [ocr, match, target.kind],
  );
  const frame = { width: probe?.frameWidth ?? 1, height: probe?.frameHeight ?? 1 };
  const selection = useMemo(
    () => scriptSelect(candidates, wanted, filter, pick, frame),
    [candidates, wanted, filter, pick, frame.width, frame.height],
  );
  const chosen = selection.chosen;
  const needsRef = NEEDS_REF.has(pick?.by ?? "reading");
  const ref = { x: pick?.refX ?? 0.5, y: pick?.refY ?? 0.5 };
  const off = { x: offset?.x ?? 0, y: offset?.y ?? 0 };
  const hasOffset = !!(off.x || off.y);
  /** Where the tap actually lands: the match, shifted by the offset. */
  const tapAt = chosen ? { x: chosen.x + off.x, y: chosen.y + off.y } : undefined;

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
            <div
              className={`tp-stage${arming ? " arming" : ""}`}
              onClick={
                arming
                  ? (e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      const at = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
                      // An offset is stored against the match, not the screen,
                      // so it is the difference between the two.
                      if (arming === "offset" && chosen) onOffsetChange?.({ x: at.x - chosen.x, y: at.y - chosen.y });
                      else if (arming === "ref") set({ pick: { refX: at.x, refY: at.y } });
                      setArming(undefined);
                    }
                  : undefined
              }
            >
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

              {/* The reference and a line to the winner: "nearest" is only
                  checkable if you can see what it measured from. */}
              {needsRef && (
                <>
                  <div className="tp-ref" style={{ left: `${ref.x * 100}%`, top: `${ref.y * 100}%` }} />
                  {chosen && (
                    <svg className="tp-link" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <line x1={ref.x * 100} y1={ref.y * 100} x2={chosen.x * 100} y2={chosen.y * 100} />
                    </svg>
                  )}
                </>
              )}

              {/* With an offset the tap is not on the match, so join the two —
                  otherwise the crosshair looks like it missed. */}
              {chosen && tapAt && hasOffset && (
                <svg className="tp-link offset" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <line x1={chosen.x * 100} y1={chosen.y * 100} x2={tapAt.x * 100} y2={tapAt.y * 100} />
                </svg>
              )}

              {tapAt && (
                <>
                  <div className="tp-cross" style={{ left: `${tapAt.x * 100}%`, top: `${tapAt.y * 100}%` }} />
                  <div
                    className={`tp-taplab${tapAt.x > 0.5 ? " flip" : ""}`}
                    style={{ left: `${tapAt.x * 100}%`, top: `${tapAt.y * 100}%` }}
                  >
                    {Math.round(tapAt.x * probe.frameWidth)},{Math.round(tapAt.y * probe.frameHeight)}
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
                      <span className="tp-key">文字色</span>
                      <label title="只接受這個顏色的文字">
                        <input
                          type="checkbox"
                          checked={!!filter?.color}
                          onChange={(e) =>
                            set({
                              filter: {
                                color: e.target.checked ? (chosen?.color ?? candidates[0]?.color ?? "#ffffff") : undefined,
                              },
                            })
                          }
                        />
                        啟用
                      </label>
                      {filter?.color && (
                        <>
                          <span className="tp-swatch" style={{ background: filter.color }} />
                          <span className="tp-val">{filter.color}</span>
                          <span className="muted">容差</span>
                          <input
                            type="range"
                            min={5}
                            max={60}
                            step={5}
                            value={Math.round((filter.colorTolerance ?? 0.15) * 100)}
                            onChange={(e) => set({ filter: { colorTolerance: Number(e.target.value) / 100 } })}
                          />
                          <span className="tp-val">{Math.round((filter.colorTolerance ?? 0.15) * 100)}%</span>
                        </>
                      )}
                    </div>
                    <div className="tp-line">
                      <span className="tp-key">字高</span>
                      <input
                        className="sp-num"
                        placeholder="不限"
                        value={filter?.minHeight ? Math.round(filter.minHeight * frame.height) : ""}
                        onChange={(e) =>
                          set({ filter: { minHeight: Number(e.target.value) ? Number(e.target.value) / frame.height : undefined } })
                        }
                      />
                      <span className="muted">–</span>
                      <input
                        className="sp-num"
                        placeholder="不限"
                        value={filter?.maxHeight ? Math.round(filter.maxHeight * frame.height) : ""}
                        onChange={(e) =>
                          set({ filter: { maxHeight: Number(e.target.value) ? Number(e.target.value) / frame.height : undefined } })
                        }
                      />
                      <span className="muted">px</span>
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
                  {onOffsetChange && (
                    <div className="tp-line">
                      <span className="tp-key">點擊偏移</span>
                      <span className="tp-val">
                        {hasOffset
                          ? `${off.x >= 0 ? "+" : ""}${Math.round(off.x * frame.width)}, ${off.y >= 0 ? "+" : ""}${Math.round(off.y * frame.height)} px`
                          : "無（點在目標上）"}
                      </span>
                      <button
                        className={arming === "offset" ? "primary" : ""}
                        disabled={!chosen}
                        title={chosen ? "在畫面上點你真正要按的位置" : "要先有命中的目標才能設偏移"}
                        onClick={() => setArming((a) => (a === "offset" ? undefined : "offset"))}
                      >
                        {arming === "offset" ? "點畫面上的位置…" : "在畫面上點選"}
                      </button>
                      {hasOffset && <button onClick={() => onOffsetChange(undefined)}>清除</button>}
                      <span className="muted" style={{ fontSize: 11 }}>
                        相對目標,目標移動時跟著走
                      </span>
                    </div>
                  )}
                  {needsRef && (
                    <div className="tp-line">
                      <span className="tp-key">參考點</span>
                      <span className="tp-val">
                        {Math.round(ref.x * frame.width)},{Math.round(ref.y * frame.height)}
                      </span>
                      <button
                        className={arming === "ref" ? "primary" : ""}
                        onClick={() => setArming((a) => (a === "ref" ? undefined : "ref"))}
                      >
                        {arming === "ref" ? "點畫面上的位置…" : "在畫面上點選"}
                      </button>
                      <span className="muted" style={{ fontSize: 11 }}>
                        預設畫面中心 — 鏡頭鎖定角色的遊戲通常就是角色所在
                      </span>
                    </div>
                  )}
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
              ) : selection.kept.length ? (
                /* Something matched — the index just points past the end of it,
                   which is a different problem from nothing matching. */
                <span className="error-text" style={{ display: "inline" }}>
                  ✕ 只符合 {selection.kept.length} 個,但設定要取第 {(pick?.index ?? 0) + 1} 個
                </span>
              ) : (
                <span className="error-text" style={{ display: "inline" }}>
                  ✕ 沒有符合的目標{selection.rejected.length ? `(${selection.rejected.length} 個被濾掉)` : ""}
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
                    <Swatch color={c.color} onPick={onChange ? (hex) => set({ filter: { color: hex } }) : undefined} />
                    <span className="tp-cand-text">{(c as Candidate).label}</span>
                    <span className="muted">{pct(c.confidence)}</span>
                    {c === chosen && <span className="tp-ok tp-cand-why">→ 會點這個</span>}
                  </button>
                ))}
                {selection.rejected.map(({ candidate, reason }, i) => (
                  <div key={`r${i}`} className="tp-cand-row out">
                    <span className="tp-cand-no">✕</span>
                    <Swatch color={candidate.color} onPick={onChange ? (hex) => set({ filter: { color: hex } }) : undefined} />
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
