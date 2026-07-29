import { scriptTextKey, type ScriptRegion, type ScriptTemplate } from "@speedcrcpy/shared";
import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Shows what a vision step would actually do, on the exact frame the probe ran
 * on: the scanned region, what was found, and — the point of the whole thing —
 * where the tap would land.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OcrProbe {
  lines: (Box & { text: string; confidence: number })[];
  /** Every place the step's text was found, in reading order — the matching
   * words, not the line they share with an icon. Computed server-side so the
   * preview and the engine cannot disagree about where a tap lands. */
  matches: (Box & { text: string })[];
  /** The one `occurrence` selects. */
  tap: (Box & { text: string }) | null;
  text: string;
  ms: number;
  frameWidth: number;
  frameHeight: number;
  preview: string;
}

interface MatchProbe extends Box {
  score: number;
  /** Every place the template passed the threshold, in reading order. */
  matches: (Box & { score: number })[];
  ms: number;
  frameWidth: number;
  frameHeight: number;
  preview: string;
  crop: string;
  scaleMismatch: { captured: string; now: string } | null;
  suggestedThreshold: number;
}

/** `selectable` marks the steps that actually act on one match (tapText /
 * findTap) — the if-steps only ask whether anything matched, so offering to
 * choose between candidates there would be meaningless. */
export type TestTarget = { selectable?: boolean } & (
  | { kind: "ocr"; region?: ScriptRegion; text?: string; occurrence?: number }
  | { kind: "match"; region?: ScriptRegion; template: ScriptTemplate; threshold: number; occurrence?: number }
);

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
/** Same normalization the engine matches with — see scriptTextKey. */
const strip = scriptTextKey;

/** Says which of several candidates the step will act on. Silent when there is
 * only one, so the note appears exactly when the choice actually matters. */
function Choice({ count, chosen, pickable }: { count: number; chosen: number; pickable: boolean }) {
  if (count < 2) return null;
  return (
    <div className="tp-choice">
      畫面上有 <b>{count}</b> 個符合,目前會點<b>第 {chosen + 1} 個</b>
      <span className="muted">
        {" "}
        · 由上而下、同一列由左而右編號{pickable ? " · 點畫面上的編號可改選" : ""}
      </span>
    </div>
  );
}

export function TestPreview({
  serial,
  target,
  onClose,
  onSuggestThreshold,
  onPickOccurrence,
}: {
  serial: string;
  target: TestTarget;
  onClose: () => void;
  onSuggestThreshold?: (value: number) => void;
  /** Makes the numbered candidates clickable; only used when the target is
   * `selectable`. */
  onPickOccurrence?: (index: number) => void;
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
        ? { region: target.region, text: target.text, occurrence: target.occurrence }
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
  const region = target.region;
  /** The step's match text, when this is a text step (narrowed once here). */
  const wanted = target.kind === "ocr" ? target.text : undefined;
  /** Candidates the step could aim at, in the same reading order the engine
   * counts — index 0 is what `occurrence` defaults to. */
  const candidates: (Box & { label: string })[] =
    target.kind === "ocr"
      ? (ocr?.matches ?? []).map((m) => ({ ...m, label: m.text }))
      : (match?.matches ?? []).map((m) => ({ ...m, label: pct(m.score) }));
  const chosen = Math.min(target.occurrence ?? 0, Math.max(0, candidates.length - 1));
  const pick = target.selectable ? onPickOccurrence : undefined;
  const hit = candidates[chosen];
  const tapX = hit?.x;
  const tapY = hit?.y;

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker-box tp-box" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>
            {target.kind === "ocr" ? "辨識結果預覽" : "找圖測試"}
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

        {probe && (
          <div className="tp-stage">
            <img src={`data:image/png;base64,${probe.preview}`} alt="" />

            {/* Scanned region; everything outside it is dimmed. */}
            {region && (
              <div
                className="tp-region"
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.w * 100}%`,
                  height: `${region.h * 100}%`,
                }}
              />
            )}

            {/* Everything OCR recognised, so a near-miss is visible too. */}
            {ocr?.lines.map((line, i) => (
              <div
                key={i}
                className="tp-box-outline"
                style={{
                  left: `${(line.x - line.w / 2) * 100}%`,
                  top: `${(line.y - line.h / 2) * 100}%`,
                  width: `${line.w * 100}%`,
                  height: `${line.h * 100}%`,
                }}
                title={`${line.text} · ${pct(line.confidence)}`}
              />
            ))}

            {/* Nothing passed the threshold: show the near miss so the author
                can see what the score was actually measuring. */}
            {match && !candidates.length && (
              <div
                className="tp-box-outline miss"
                style={{
                  left: `${(match.x - match.w / 2) * 100}%`,
                  top: `${(match.y - match.h / 2) * 100}%`,
                  width: `${match.w * 100}%`,
                  height: `${match.h * 100}%`,
                }}
              />
            )}

            {/* The candidates, numbered in the order the engine counts them.
                Which one gets tapped is a choice, so make it a visible one. */}
            {candidates.map((c, i) => (
              <div
                key={i}
                className={`tp-box-outline tp-cand${i === chosen ? " hit tp-refined" : ""}${pick ? " pickable" : ""}`}
                style={{
                  left: `${(c.x - c.w / 2) * 100}%`,
                  top: `${(c.y - c.h / 2) * 100}%`,
                  width: `${c.w * 100}%`,
                  height: `${c.h * 100}%`,
                }}
                title={`第 ${i + 1} 個 · ${c.label}`}
                onClick={pick ? () => pick(i) : undefined}
              >
                {candidates.length > 1 && <span className="tp-cand-no">{i + 1}</span>}
              </div>
            ))}

            {tapX !== undefined && tapY !== undefined && (
              <>
                <div className="tp-cross" style={{ left: `${tapX * 100}%`, top: `${tapY * 100}%` }} />
                {/* Pixels only — the preview is narrow, and a longer label gets
                    clipped at the edge. The normalized pair is in the footer. */}
                <div
                  className={`tp-taplab${tapX > 0.5 ? " flip" : ""}`}
                  style={{ left: `${tapX * 100}%`, top: `${tapY * 100}%` }}
                >
                  {Math.round(tapX * probe.frameWidth)},{Math.round(tapY * probe.frameHeight)}
                </div>
              </>
            )}
          </div>
        )}

        {ocr && (
          <div className="tp-foot">
            <div>
              {wanted ? (
                hit ? (
                  <span className="tp-ok">
                    ✓ 找到符合「{wanted}」的文字
                    {strip(hit.label) !== strip(wanted) ? ` — 已收窄到「${hit.label}」` : ""}
                    <span className="muted">
                      {" "}
                      · 點擊 ({hit.x.toFixed(3)}, {hit.y.toFixed(3)})
                    </span>
                  </span>
                ) : (
                  <span className="error-text" style={{ display: "inline" }}>
                    ✕ 沒有符合「{wanted}」的文字 — 請照下方實際讀到的內容調整
                  </span>
                )
              ) : (
                <span className="muted">辨識完成</span>
              )}
              <span className="muted"> · {ocr.ms}ms · {ocr.frameWidth}×{ocr.frameHeight}</span>
            </div>
            <Choice count={candidates.length} chosen={chosen} pickable={!!pick} />
            <div className="tp-read">
              <span className="muted">讀到:</span> {ocr.text || "(沒讀到文字)"}
            </div>
          </div>
        )}

        {match && target.kind === "match" && (
          <div className="tp-foot">
            <div className="tp-cmp">
              <figure>
                <img src={`data:image/png;base64,${target.template.png}`} alt="" />
                <figcaption>模板</figcaption>
              </figure>
              <span className="tp-arrow">→</span>
              <figure>
                <img className={hit ? "hit" : ""} src={`data:image/png;base64,${match.crop}`} alt="" />
                <figcaption>畫面上</figcaption>
              </figure>
              <div className="tp-bar">
                <div className="tp-barline">
                  <div className={`tp-fill${hit ? " hit" : ""}`} style={{ width: pct(match.score) }} />
                  <div className="tp-thr" style={{ left: pct(target.threshold) }} />
                </div>
                <div className="tp-score">
                  <span className={hit ? "tp-ok" : "error-text"} style={{ display: "inline" }}>
                    相似度 {pct(match.score)} {hit ? "✓ 通過" : `✕ 未達門檻 ${pct(target.threshold)}`}
                  </span>
                  <span className="muted">{match.ms}ms</span>
                </div>
              </div>
            </div>
            <Choice count={candidates.length} chosen={chosen} pickable={!!pick} />
            {onSuggestThreshold && (
              <div className="tp-suggest">
                <span className="muted">建議門檻 {pct(match.suggestedThreshold)}</span>
                <button onClick={() => onSuggestThreshold(match.suggestedThreshold)}>套用</button>
              </div>
            )}
            {match.scaleMismatch && (
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
