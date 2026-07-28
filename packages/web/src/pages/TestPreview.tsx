import type { ScriptRegion, ScriptTemplate } from "@speedcrcpy/shared";
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
  text: string;
  ms: number;
  frameWidth: number;
  frameHeight: number;
  preview: string;
}

interface MatchProbe extends Box {
  score: number;
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

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const strip = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function TestPreview({
  serial,
  target,
  onClose,
  onSuggestThreshold,
}: {
  serial: string;
  target: TestTarget;
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
    const body = target.kind === "ocr" ? { region: target.region } : { region: target.region, template: target.template };
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
  // OCR: the line that the step's text would match. Match: the single best hit.
  const hit =
    target.kind === "ocr"
      ? ocr?.lines.find((l) => wanted && strip(l.text).includes(strip(wanted)))
      : match && match.score >= target.threshold
        ? match
        : undefined;
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
                className={`tp-box-outline${line === hit ? " hit" : ""}`}
                style={{
                  left: `${(line.x - line.w / 2) * 100}%`,
                  top: `${(line.y - line.h / 2) * 100}%`,
                  width: `${line.w * 100}%`,
                  height: `${line.h * 100}%`,
                }}
                title={`${line.text} · ${pct(line.confidence)}`}
              />
            ))}

            {/* The single best template match (green only when it passes). */}
            {match && (
              <div
                className={`tp-box-outline${hit ? " hit" : " miss"}`}
                style={{
                  left: `${(match.x - match.w / 2) * 100}%`,
                  top: `${(match.y - match.h / 2) * 100}%`,
                  width: `${match.w * 100}%`,
                  height: `${match.h * 100}%`,
                }}
              />
            )}

            {tapX !== undefined && tapY !== undefined && (
              <>
                <div className="tp-cross" style={{ left: `${tapX * 100}%`, top: `${tapY * 100}%` }} />
                <div className="tp-taplab" style={{ left: `${tapX * 100}%`, top: `${tapY * 100}%` }}>
                  點擊 ({tapX.toFixed(3)}, {tapY.toFixed(3)}) → {Math.round(tapX * probe.frameWidth)},
                  {Math.round(tapY * probe.frameHeight)}
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
                  <span className="tp-ok">✓ 找到符合「{wanted}」的文字</span>
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
