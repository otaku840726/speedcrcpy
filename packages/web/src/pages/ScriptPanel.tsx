import { type DeviceInfo, MAX_TEMPLATE_BASE64, PRIORITY_LABELS, SCRIPT_STEP_LABELS, type Script, type ScriptFilter, type ScriptKey, type ScriptPick, type ScriptRegion, type ScriptStatus, type ScriptStep, type ScriptTemplate, type ScriptTrigger, type ScriptVariable } from "@speedcrcpy/shared";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";
import {
  appendTo,
  childrenOf,
  editList,
  insertAfter,
  insertBefore,
  insideLoop,
  intoBranch,
  labelsInScope,
  moveAt,
  type Path,
  removeAt,
  replaceAt,
} from "./step-tree";
import { CallStepBody, IfVarBody } from "./script-call";
import { AppStepBody } from "./script-app";
import { IdentifyBody } from "./script-identify";
import { asDraft, type Draft, draftBody, isSaved, newDraft, stableJson } from "./script-draft";
import { VariablesPanel } from "./script-vars";
import { TestPreview, type TestTarget } from "./TestPreview";

const MODE_LABELS: Record<string, string> = { standalone: "前後無字", exact: "整行相符" };
const ORDER_LABELS: Record<string, string> = {
  left: "最左起",
  right: "最右起",
  top: "最上起",
  bottom: "最下起",
  score: "最像的起",
  nearest: "離參考點最近",
  farthest: "離參考點最遠",
  random: "隨機",
};

/**
 * What the step will do about several matches, on the step row itself. Silent
 * while everything is default, so a step that doesn't use any of this looks
 * exactly as it did before.
 */
function PickSummary({
  filter,
  pick,
  offsetX,
  offsetY,
}: { filter?: ScriptFilter; pick?: ScriptPick; offsetX?: number; offsetY?: number }) {
  const parts = [
    filter?.mode && filter.mode !== "contains" ? MODE_LABELS[filter.mode] : null,
    filter?.color ? `色 ${filter.color}` : null,
    filter?.minHeight || filter?.maxHeight ? "限字高" : null,
    filter?.minConfidence ? `信心 ≥${Math.round(filter.minConfidence * 100)}%` : null,
    pick?.expect === "one" ? "剛好 1 個" : null,
    pick?.by && pick.by !== "reading" ? ORDER_LABELS[pick.by] : null,
    pick?.index ? `第 ${pick.index + 1} 個` : null,
    offsetX || offsetY ? "有偏移" : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="sp-summary">{parts.join(" · ")}</span>;
}

const KEY_LABELS: Record<string, string> = {
  back: "返回",
  home: "主畫面",
  recents: "多工",
  power: "電源",
  wake: "喚醒",
  volumeUp: "音量+",
  volumeDown: "音量-",
};

/**
 * The palette, in the order it reads on screen. Names come from the shared map
 * so the run log calls a step what the editor calls it.
 *
 * New steps start with a zero timeout — look once, then move on. Waiting is a
 * decision about a particular step, and a default that waits makes every step
 * that does not need to sit there for eight seconds before anyone notices.
 */
const NEW_STEPS: { make: () => ScriptStep; key: boolean }[] = [
  { key: true, make: () => ({ type: "call", scriptId: "", args: [], outputs: [] }) },
  { key: true, make: () => ({ type: "goto", target: "" }) },
  { key: true, make: () => ({ type: "stop", scope: "script" }) },
  { key: true, make: () => ({ type: "ifVar", name: "", compare: "==", then: [], else: [] }) },
  { key: true, make: () => ({ type: "findTap", template: EMPTY_TEMPLATE(), threshold: 0.85, timeoutMs: 0 }) },
  { key: true, make: () => ({ type: "identify", cases: [], timeoutMs: 0 }) },
  { key: false, make: () => ({ type: "app", action: "restart", package: "", waitMs: 15000 }) },
  { key: true, make: () => ({ type: "ifImage", template: EMPTY_TEMPLATE(), threshold: 0.85, then: [], else: [] }) },
  { key: true, make: () => ({ type: "tapText", text: "", timeoutMs: 0 }) },
  { key: true, make: () => ({ type: "ifText", text: "", then: [], else: [] }) },
  { key: true, make: () => ({ type: "ifNumber", compare: ">", value: 0, then: [], else: [] }) },
  { key: false, make: () => ({ type: "tap", x: 0.5, y: 0.5 }) },
  { key: false, make: () => ({ type: "swipe", x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3, durationMs: 300 }) },
  { key: false, make: () => ({ type: "wait", minMs: 500, maxMs: 500 }) },
  { key: false, make: () => ({ type: "waitColor", x: 0.5, y: 0.5, color: "#ffffff", tolerance: 0.1, timeoutMs: 0 }) },
  { key: false, make: () => ({ type: "ifColor", x: 0.5, y: 0.5, color: "#ffffff", tolerance: 0.1, then: [], else: [] }) },
  { key: false, make: () => ({ type: "loop", count: 0, body: [] }) },
  { key: false, make: () => ({ type: "text", value: "" }) },
  { key: false, make: () => ({ type: "key", key: "back" }) },
];

function EMPTY_TEMPLATE(): ScriptTemplate {
  return { png: "", capturedWidth: 0, capturedHeight: 0 };
}

/**
 * The step a 複製 or 剪下 put aside, at module scope rather than in the panel's
 * state: a step copied out of one script is usually wanted in another, and
 * closing the panel in between should not lose it. Deliberately not persisted —
 * one step can carry a 4 MB template and localStorage has ~5 MB for everything.
 */
let clipboard: ScriptStep | undefined;

/**
 * Edits in progress, for the same reason and in the same place as the
 * clipboard: closing the panel to go and look at the game is part of editing,
 * not the end of it. Every one of these is mirrored to the server (debounced),
 * which is what carries them across a reload or to another browser.
 */
const localDrafts = new Map<string, Draft>();
/** What the server already has, per draft, so an unchanged body is never
 * uploaded twice. */
const sentDrafts = new Map<string, string>();
let openDraftKey: string | undefined;
const openDraft = (): Draft | undefined => (openDraftKey ? localDrafts.get(openDraftKey) : undefined);

/** How long to wait after the last edit before mirroring a draft to the server.
 * A draft carries its image templates, so this is megabytes on a link this
 * project exists to be careful with — waiting for a pause and skipping an
 * unchanged body keeps it to roughly one upload per burst of editing. */
const DRAFT_SYNC_MS = 2000;

/**
 * Which blocks are folded shut, keyed by script and path.
 *
 * Deliberately not part of the script: how you happen to be looking at a tree
 * is not something to save, send to the server, or count as an unsaved change.
 * Module-level so it survives closing the panel, like the clipboard.
 */
const collapsed = new Map<string, Set<string>>();
/**
 * How far down each script was scrolled, kept where the drafts and the fold
 * state are kept.
 *
 * Closing the panel to look at the device is part of editing — the draft
 * already survives it, and arriving back at the top of a forty-step script to
 * hunt for where you were undoes most of that.
 */
const scrollTops = new Map<string, number>();
const foldKey = (path: Path) => path.map((p) => `${p.index}${p.branch ?? ""}`).join("/");

// ---- picker ----

type PickMode = "point" | "swipe" | "template" | "region";
interface PickResult {
  x: number;
  y: number;
  color: string;
  x2?: number;
  y2?: number;
  template?: ScriptTemplate;
  region?: { x: number; y: number; w: number; h: number };
}

/** Screenshot overlay: click a point (colour is sampled), drag a swipe, or
 * marquee-select a template crop. */
function Picker({ serial, mode, onPick, onClose }: { serial: string; mode: PickMode; onPick: (r: PickResult) => void; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{
    target: TestTarget;
    path: Path;
    selectable: boolean;
    filter?: ScriptFilter;
    pick?: ScriptPick;
    offset?: { x: number; y: number };
  }>();
  /** Set the moment 執行 is clicked so the UI responds before the server does. */
  const [starting, setStarting] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  /** Last marquee produced a template past the size cap — shown in place of the
   * hint until the next drag replaces it. */
  const [tooBig, setTooBig] = useState(false);

  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    fetch(`/api/devices/${encodeURIComponent(serial)}/screenshot`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("擷取畫面失敗"))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          const canvas = canvasRef.current;
          if (!canvas) return;
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d")?.drawImage(img, 0, 0);
        };
        img.src = url;
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "擷取畫面失敗"));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [serial]);

  /** Pointer position → normalized (0-1) canvas coords. */
  const toNorm = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const colorAt = (nx: number, ny: number): string => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx) return "#000000";
    const px = ctx.getImageData(Math.round(nx * (canvas.width - 1)), Math.round(ny * (canvas.height - 1)), 1, 1).data;
    return `#${[px[0]!, px[1]!, px[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  };

  const onDown = (e: React.PointerEvent) => {
    const p = toNorm(e);
    if (mode === "point") {
      onPick({ x: p.x, y: p.y, color: colorAt(p.x, p.y) });
      onClose();
      return;
    }
    dragRef.current = p;
    setTooBig(false);
    setDrag({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const p = toNorm(e);
    setDrag({ x1: dragRef.current.x, y1: dragRef.current.y, x2: p.x, y2: p.y });
  };

  const onUp = () => {
    const start = dragRef.current;
    dragRef.current = null;
    if (!start || !drag) return;

    if (mode === "swipe") {
      onPick({ x: drag.x1, y: drag.y1, x2: drag.x2, y2: drag.y2, color: colorAt(drag.x1, drag.y1) });
      onClose();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (mode === "region") {
      const rx = Math.min(drag.x1, drag.x2), ry = Math.min(drag.y1, drag.y2);
      const rw = Math.abs(drag.x2 - drag.x1), rh = Math.abs(drag.y2 - drag.y1);
      if (rw < 0.01 || rh < 0.01) { setDrag(null); return; }
      onPick({ x: rx + rw / 2, y: ry + rh / 2, color: colorAt(rx, ry), region: { x: rx, y: ry, w: rw, h: rh } });
      onClose();
      return;
    }
    // template: crop the marquee out of the screenshot
    const x = Math.round(Math.min(drag.x1, drag.x2) * canvas.width);
    const y = Math.round(Math.min(drag.y1, drag.y2) * canvas.height);
    const w = Math.round(Math.abs(drag.x2 - drag.x1) * canvas.width);
    const h = Math.round(Math.abs(drag.y2 - drag.y1) * canvas.height);
    if (w < 8 || h < 8) {
      setDrag(null);
      return;
    }
    const crop = document.createElement("canvas");
    crop.width = w;
    crop.height = h;
    crop.getContext("2d")?.drawImage(canvas, x, y, w, h, 0, 0, w, h);
    const png = crop.toDataURL("image/png").split(",")[1] ?? "";
    // Say it here, with the picture still up and the marquee cleared, rather
    // than letting a template the server will refuse reach a step and fail on
    // the next 測試 or 儲存.
    if (png.length > MAX_TEMPLATE_BASE64) {
      setTooBig(true);
      setDrag(null);
      return;
    }
    onPick({
      x: (x + w / 2) / canvas.width,
      y: (y + h / 2) / canvas.height,
      color: colorAt((x + w / 2) / canvas.width, (y + h / 2) / canvas.height),
      template: {
        png,
        capturedWidth: canvas.width,
        capturedHeight: canvas.height,
      },
    });
    onClose();
  };

  const hint =
    mode === "point"
      ? "點一下畫面取座標與顏色"
      : mode === "swipe"
        ? "從起點拖曳到終點"
        : mode === "region"
          ? "框選辨識範圍(範圍越小越快越準)"
          : "框選要比對的圖像";

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker-box" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span className={tooBig ? "error-text" : undefined}>{tooBig ? "框選範圍太大,請框小一點" : hint}</span>
          <button onClick={onClose}>取消</button>
        </div>
        {error ? (
          <p className="error-text" style={{ padding: 20 }}>{error}</p>
        ) : (
          <div className="picker-stage">
            <canvas
              ref={canvasRef}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            />
            {drag && mode !== "point" && (
              <div
                className={mode === "swipe" ? "picker-line" : "picker-rect"}
                style={
                  mode === "swipe"
                    ? {
                        left: `${Math.min(drag.x1, drag.x2) * 100}%`,
                        top: `${Math.min(drag.y1, drag.y2) * 100}%`,
                        width: `${Math.abs(drag.x2 - drag.x1) * 100}%`,
                        height: `${Math.abs(drag.y2 - drag.y1) * 100}%`,
                      }
                    : {
                        left: `${Math.min(drag.x1, drag.x2) * 100}%`,
                        top: `${Math.min(drag.y1, drag.y2) * 100}%`,
                        width: `${Math.abs(drag.x2 - drag.x1) * 100}%`,
                        height: `${Math.abs(drag.y2 - drag.y1) * 100}%`,
                      }
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- step rows ----

function StepRow({
  step,
  path,
  serial,
  onChange,
  onRemove,
  onMove,
  onAdd,
  onInsert,
  onCopy,
  onCut,
  onPaste,
  clip,
  pick,
  probe,
  modules,
  variables,
  labels,
  inLoop,
  isModule,
  onRunHere,
  onEditModule,
  editingModule,
  renderModule,
  scriptKey,
  onFold,
}: {
  step: ScriptStep;
  path: Path;
  /** Which device to ask about installed apps — the App step's picker needs it. */
  serial: string;
  onChange: (path: Path, next: ScriptStep) => void;
  onRemove: (path: Path) => void;
  onMove: (path: Path, dir: -1 | 1) => void;
  onAdd: (path: Path, branch: "body" | "then" | "else", step: ScriptStep) => void;
  /** Put a step in the gap above the row at `path`. */
  onInsert: (path: Path, step: ScriptStep) => void;
  onCopy: (step: ScriptStep) => void;
  onCut: (path: Path, step: ScriptStep) => void;
  /** Paste the clipboard directly below this row. */
  onPaste: (path: Path) => void;
  /** What is on the clipboard, so the row can offer 貼上 only when there is
   * something to paste, and name it. */
  clip: ScriptStep | undefined;
  pick: (mode: PickMode, apply: (r: PickResult) => void) => void;
  probe: (target: TestTarget, path: Path, step: ScriptStep) => void;
  /** Scripts flagged as modules — what a call step can point at. */
  modules: Script[];
  /** The enclosing script's declared variables. */
  variables: ScriptVariable[];
  /** Step names a jump here may aim at — this list and the ones outside it. */
  labels: string[];
  /** Whether this row sits inside a 重複, and whether the script is a module:
   * between them they decide which kinds of 停止 are on offer. */
  inLoop: boolean;
  isModule: boolean;
  /** Run only this step, for checking one block without the rest. The step
   * itself travels, so what runs is what is on screen — saved or not. */
  onRunHere: (step: ScriptStep) => void;
  onEditModule: (scriptId: string) => void;
  editingModule: string | undefined;
  /** The called module's own editor, rendered inside this row. */
  renderModule: (scriptId: string) => React.ReactNode;
  /** Identifies the script these paths belong to, for the fold state. */
  scriptKey: string;
  onFold: () => void;
}) {
  const set = (patch: Partial<ScriptStep>) => onChange(path, { ...step, ...patch } as ScriptStep);
  const num = (v: string) => Number(v) || 0;
  const [naming, setNaming] = useState(false);

  const coordChip = (x: number, y: number, apply: (r: PickResult) => void) => (
    <button className="sp-pick" onClick={() => pick("point", apply)} title="從畫面拾取">
      <Icon name="crosshair" size={13} /> {x.toFixed(2)}, {y.toFixed(2)}
    </button>
  );

  /** Search area, for every step that takes one — text and image alike. Both
   * only look at what you framed, so the reasons to set one differ in degree,
   * not in kind: the tooltip says which applies. */
  const regionChipFor = (region: ScriptRegion | undefined, unsetLabel: string, unsetTitle: string) => (
    <button
      className={`sp-pick${region ? "" : " warn"}`}
      onClick={() => pick("region", (r) => r.region && set({ region: r.region }))}
      title={region ? "重新框選搜尋範圍" : unsetTitle}
    >
      <Icon name="crosshair" size={13} />
      {region ? `${(region.w * 100).toFixed(0)}×${(region.h * 100).toFixed(0)}%` : unsetLabel}
    </button>
  );

  // Read before the bodies are built, not just by the chrome around them: a
  // step whose whole content is a list says something shorter when folded.
  const folds = collapsed.get(scriptKey) ?? new Set<string>();
  const shut = folds.has(foldKey(path));

  let body: React.ReactNode = null;
  switch (step.type) {
    case "tap":
      body = <>點擊 {coordChip(step.x, step.y, (r) => set({ x: r.x, y: r.y }))}</>;
      break;
    case "swipe":
      body = (
        <>
          滑動
          <button className="sp-pick" onClick={() => pick("swipe", (r) => set({ x1: r.x, y1: r.y, x2: r.x2 ?? r.x, y2: r.y2 ?? r.y }))} title="拖曳拾取">
            <Icon name="crosshair" size={13} /> {step.x1.toFixed(2)},{step.y1.toFixed(2)} → {step.x2.toFixed(2)},{step.y2.toFixed(2)}
          </button>
          <input className="sp-num" value={step.durationMs} onChange={(e) => set({ durationMs: num(e.target.value) })} /> ms
        </>
      );
      break;
    case "wait":
      body = (
        <>
          等待 <input className="sp-num" value={step.minMs} onChange={(e) => set({ minMs: num(e.target.value) })} />
          –<input className="sp-num" value={step.maxMs} onChange={(e) => set({ maxMs: num(e.target.value) })} /> ms
        </>
      );
      break;
    case "text":
      body = (
        <>
          輸入 <input className="sp-text" value={step.value} onChange={(e) => set({ value: e.target.value })} placeholder="文字" />
        </>
      );
      break;
    case "key":
      body = (
        <>
          按鍵
          <select value={step.key} onChange={(e) => set({ key: e.target.value as ScriptKey })}>
            {Object.entries(KEY_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
        </>
      );
      break;
    case "waitColor":
    case "ifColor":
      body = (
        <>
          {step.type === "waitColor" ? "等待顏色" : "若顏色"}
          {coordChip(step.x, step.y, (r) => set({ x: r.x, y: r.y, color: r.color }))}
          <span className="sp-swatch" style={{ background: step.color }} />
          <input className="sp-hex" value={step.color} onChange={(e) => set({ color: e.target.value })} />
          容差 <input className="sp-num" value={Math.round(step.tolerance * 100)} onChange={(e) => set({ tolerance: num(e.target.value) / 100 })} />%
          {step.type === "waitColor" && (
            <>
              逾時 <input className="sp-num" value={step.timeoutMs} onChange={(e) => set({ timeoutMs: num(e.target.value) })} />ms
            </>
          )}
        </>
      );
      break;
    case "goto":
      body = (
        <>
          <Icon name="goto" size={14} />
          跳到
          <select value={step.target} onChange={(e) => set({ target: e.target.value })}>
            <option value="">— 選標記 —</option>
            {labels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          {!labels.length && <span className="sp-warn-inline">還沒有任何標記 — 先幫要跳到的步驟取名</span>}
        </>
      );
      break;
    case "stop":
      body = (
        <>
          <Icon name="stop" size={13} />
          停止
          <select value={step.scope} onChange={(e) => set({ scope: e.target.value as typeof step.scope })}>
            <option value="script">整支腳本</option>
            {/* Only offered where they mean something: the save would refuse
                them anyway, and a menu that offers a mistake is a poor menu. */}
            {inLoop && <option value="loop">跳出這個迴圈</option>}
            {inLoop && <option value="iteration">下一輪</option>}
            {isModule && <option value="module">結束這個模組</option>}
          </select>
        </>
      );
      break;
    case "call":
      body = (
        <CallStepBody
          compact={collapsed.get(scriptKey)?.has(foldKey(path))}
          step={step}
          modules={modules}
          onChange={(patch) => set(patch as Partial<ScriptStep>)}
          onEdit={() => onEditModule(step.scriptId)}
          editing={editingModule === step.scriptId}
          pickTemplate={(apply) => pick("template", (r) => r.template && apply(r.template))}
          pickRegion={(apply) => pick("region", (r) => r.region && apply(r.region))}
          callerVars={variables}
        />
      );
      break;
    case "ifVar":
      body = <IfVarBody step={step} variables={variables} onChange={(patch) => set(patch as Partial<ScriptStep>)} />;
      break;
    case "app":
      body = <AppStepBody step={step} serial={serial} onChange={(patch) => set(patch as Partial<ScriptStep>)} />;
      break;
    case "identify":
      body = (
        <IdentifyBody
          step={step}
          serial={serial}
          variables={variables}
          compact={shut}
          onChange={(patch) => set(patch as Partial<ScriptStep>)}
          pickTemplate={(apply) => pick("template", (r) => r.template && apply(r.template))}
          pickRegion={(apply) => pick("region", (r) => r.region && apply(r.region))}
        />
      );
      break;
    case "findTap":
    case "ifImage":
      body = (
        <>
          {step.type === "findTap" ? "找圖點擊" : "若找到圖"}
          <button className="sp-tmpl" onClick={() => pick("template", (r) => r.template && set({ template: r.template }))} title="框選圖像">
            {step.template.png ? (
              <img src={`data:image/png;base64,${step.template.png}`} alt="" />
            ) : (
              <Icon name="image" size={16} />
            )}
          </button>
          {regionChipFor(
            step.region,
            "整張",
            "未框選範圍:整張畫面(比對慢約 30 倍,且畫面別處若有相似圖案也可能被選中)",
          )}
          相似度 <input className="sp-num" value={Math.round(step.threshold * 100)} onChange={(e) => set({ threshold: num(e.target.value) / 100 })} />%
          <button
            className="sp-probe"
            disabled={!step.template.png}
            onClick={() =>
              probe(
                {
                  kind: "match",
                  region: step.region,
                  template: step.template,
                  threshold: step.threshold,
                },
                path,
                step,
              )
            }
            title={step.template.png ? "測試:看比對到哪裡、相似度多少" : "請先框選圖像"}
          >
            設定與測試
          </button>
          {/* Only on 若找到圖 — 找圖點擊 taps by definition. Tapping here rather
              than from a 找圖點擊 inside 成立 saves that branch a second capture
              of the picture this step has already found. */}
          {step.type === "ifImage" && (
            <label className="sp-case-tap" title="找到時直接點擊它,再走「成立」分支">
              <input type="checkbox" checked={!!step.tap} onChange={(e) => set({ tap: e.target.checked || undefined })} />
              找到就點擊
            </label>
          )}
          {step.type === "findTap" && (
            <PickSummary filter={step.filter} pick={step.pick} offsetX={step.offsetX} offsetY={step.offsetY} />
          )}
          {step.type === "findTap" && (
            <>
              逾時 <input className="sp-num" value={step.timeoutMs} onChange={(e) => set({ timeoutMs: num(e.target.value) })} />ms
            </>
          )}
        </>
      );
      break;
    case "tapText":
    case "ifText":
    case "ifNumber": {
      const regionChip = regionChipFor(
        step.region,
        "整張(慢)",
        "未框選範圍:整張畫面(慢約 30 倍,座標較粗略)",
      );
      body =
        step.type === "ifNumber" ? (
          <>
            讀取數值 {regionChip}
            <select value={step.compare} onChange={(e) => set({ compare: e.target.value as typeof step.compare })}>
              {[">", ">=", "<", "<=", "=="].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <input className="sp-num" value={step.value} onChange={(e) => set({ value: num(e.target.value) })} />
          </>
        ) : (
          <>
            {step.type === "tapText" ? "依文字點擊" : "若文字含"} {regionChip}
            <input
              className="sp-text"
              value={step.text}
              onChange={(e) => set({ text: e.target.value })}
              placeholder="要比對的文字(部分即可)"
            />
            <button
              className="sp-probe"
              onClick={() =>
                probe(
                  {
                    kind: "ocr",
                    region: step.region,
                    text: step.text,
                  },
                  path,
                  step,
                )
              }
              title="測試:看實際讀到什麼、會點在哪裡"
            >
              設定與測試
            </button>
            {step.type === "tapText" && (
              <>
                <PickSummary filter={step.filter} pick={step.pick} offsetX={step.offsetX} offsetY={step.offsetY} />
                逾時 <input className="sp-num" value={step.timeoutMs} onChange={(e) => set({ timeoutMs: num(e.target.value) })} />ms
              </>
            )}
          </>
        );
      break;
    }
    case "loop":
      body = (
        <>
          重複 <input className="sp-num" value={step.count} onChange={(e) => set({ count: num(e.target.value) })} /> 次
          <span className="muted" style={{ fontSize: 11 }}>(0 = 無限)</span>
        </>
      );
      break;
  }

  const branches: ("body" | "then" | "else")[] =
    step.type === "loop"
      ? ["body"]
      : step.type === "ifColor" || step.type === "ifImage" || step.type === "ifText" || step.type === "ifNumber" || step.type === "ifVar"
        ? ["then", "else"]
        : [];

  // A call is foldable too: expanding it is what opens the module's editor.
  // So is 辨識情境 — its list of pictures is the tallest thing a row can hold.
  const foldable = branches.length > 0 || step.type === "call" || step.type === "identify";
  const toggleFold = () => {
    const next = collapsed.get(scriptKey) ?? new Set<string>();
    shut ? next.delete(foldKey(path)) : next.add(foldKey(path));
    collapsed.set(scriptKey, next);
    onFold();
  };
  /** What a folded block says about itself — enough to not need opening. */
  const summary = branches
    .map((b) => `${b === "body" ? "" : b === "then" ? "成立 " : "否則 "}${childrenOf(step, b).length}`)
    .join(" / ");

  return (
    <div className={`sp-step${branches.length ? " sp-block" : ""}${step.disabled ? " off" : ""}`}>
      <div className="sp-line">
        {foldable ? (
          <button className="sp-fold" onClick={toggleFold} title={shut ? "展開" : "折疊"}>
            <Icon name={shut ? "next" : "arrowDown"} size={11} />
          </button>
        ) : (
          <span className="sp-fold-gap" />
        )}
        {/* Off but kept. Written as `undefined` rather than `false` so a step
            that was never switched off stays exactly as it was on disk. */}
        <input
          className="sp-onoff"
          type="checkbox"
          checked={!step.disabled}
          onChange={(e) => set({ disabled: e.target.checked ? undefined : true })}
          title={
            step.disabled
              ? `已關閉,執行時會略過${branches.length ? "(含裡面的步驟)" : ""} — 點一下開啟`
              : `關閉這個步驟:保留設定但執行時略過${branches.length ? "(含裡面的步驟)" : ""}`
          }
        />
        <span className="sp-body">
          {/* A step's name: what the log will call it, what a jump aims at, and
              what a folded block shows. Empty by default and one click away. */}
          {naming ? (
            <input
              className="sp-label-edit"
              autoFocus
              value={step.label ?? ""}
              placeholder="這一步叫什麼"
              onChange={(e) => set({ label: e.target.value || undefined })}
              onBlur={() => setNaming(false)}
              onKeyDown={(e) => e.key === "Enter" && setNaming(false)}
            />
          ) : step.label ? (
            <button className="sp-label" title="改名稱" onClick={() => setNaming(true)}>
              <Icon name="bookmark" size={11} /> {step.label}
            </button>
          ) : (
            <button className="sp-label empty" title="幫這一步取個名字(執行紀錄和跳躍都會用到)" onClick={() => setNaming(true)}>
              <Icon name="bookmark" size={11} />
            </button>
          )}
          {body}
          {shut && summary && <span className="sp-summary">內含 {summary} 步</span>}
        </span>
        <span className="sp-actions">
          <button onClick={() => onRunHere(step)} title="只執行這一段(用畫面上的內容,不必先儲存)"><Icon name="play" size={12} /></button>
          <button onClick={() => onMove(path, -1)} title="上移"><Icon name="arrowUp" size={12} /></button>
          <button onClick={() => onMove(path, 1)} title="下移"><Icon name="arrowDown" size={12} /></button>
          <button onClick={() => onCopy(step)} title="複製(含底下的子步驟)"><Icon name="copy" size={12} /></button>
          <button onClick={() => onCut(path, step)} title="剪下"><Icon name="scissors" size={12} /></button>
          {clip && (
            <button onClick={() => onPaste(path)} title={`貼上「${SCRIPT_STEP_LABELS[clip.type]}」到這列下方`}>
              <Icon name="clipboard" size={12} />
            </button>
          )}
          <button onClick={() => onRemove(path)} title="刪除"><Icon name="trash" size={12} /></button>
        </span>
      </div>
      {step.type === "call" && !shut && editingModule === step.scriptId && renderModule(step.scriptId)}
      {!shut &&
        branches.map((branch) => (
        <div key={branch} className={`sp-branch sp-branch-${branch}`}>
          {branches.length > 1 && <div className="sp-branch-label">{branch === "then" ? "成立" : "否則"}</div>}
          {childrenOf(step, branch).map((child, i) => (
            <Fragment key={i}>
            <InsertPoint clip={clip} onInsert={(s) => onInsert([...intoBranch(path, branch), { index: i }], s)} />
            <StepRow
              step={child}
              serial={serial}
              path={[...intoBranch(path, branch), { index: i }]}
              onChange={onChange}
              onRemove={onRemove}
              onMove={onMove}
              onAdd={onAdd}
              onInsert={onInsert}
              onCopy={onCopy}
              onCut={onCut}
              onPaste={onPaste}
              clip={clip}
              pick={pick}
              probe={probe}
              modules={modules}
              variables={variables}
              labels={[...labels, ...childrenOf(step, branch).map((c) => c.label).filter((l): l is string => !!l)]}
              inLoop={inLoop || step.type === "loop"}
              isModule={isModule}
              onRunHere={onRunHere}
              onEditModule={onEditModule}
              editingModule={editingModule}
              renderModule={renderModule}
              scriptKey={scriptKey}
              onFold={onFold}
            />
            </Fragment>
          ))}
          <AddMenu onAdd={(s) => onAdd(path, branch, s)} clip={clip} />
        </div>
        ))}
    </div>
  );
}

/** Every kind of step, plus whatever is on the clipboard. Shared so the two
 *  ways in — append at the end, insert between two rows — offer the same list. */
function StepPalette({ onPick, clip }: { onPick: (step: ScriptStep) => void; clip: ScriptStep | undefined }) {
  return (
    <div className="sp-palette">
      {clip && (
        <button className="sp-chip paste" onClick={() => onPick(structuredClone(clip))}>
          <Icon name="clipboard" size={12} /> 貼上「{SCRIPT_STEP_LABELS[clip.type]}」
        </button>
      )}
      {NEW_STEPS.map((s) => (
        <button key={s.make().type} className={s.key ? "sp-chip key" : "sp-chip"} onClick={() => onPick(s.make())}>
          {SCRIPT_STEP_LABELS[s.make().type]}
        </button>
      ))}
    </div>
  );
}

/** Appends to the end of this list — the only way into a branch that has no
 *  rows yet, since an insert point needs a row to sit above. */
function AddMenu({ onAdd, clip }: { onAdd: (step: ScriptStep) => void; clip: ScriptStep | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sp-add">
      <button className="sp-add-btn" onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={12} /> 新增步驟
      </button>
      {open && (
        <StepPalette
          clip={clip}
          onPick={(step) => {
            onAdd(step);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The gap above a step, as a place to put one.
 *
 * Adding a step used to mean appending to the end of the list and then walking
 * it up one press at a time — unusable on a script of any length, which is
 * exactly where you most want to insert something. Sitting between the rows,
 * this needs no row to anchor to and no direction to remember: the step lands
 * where the line is.
 */
function InsertPoint({ onInsert, clip }: { onInsert: (step: ScriptStep) => void; clip: ScriptStep | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "sp-insert-wrap open" : "sp-insert-wrap"}>
      <div className="sp-insert">
        {/* The plus turns into a cross by rotating, so opening and closing is
            one control rather than two icons. */}
        <button className="sp-insert-btn" title="在這裡插入步驟" onClick={() => setOpen((v) => !v)}>
          <Icon name="plus" size={12} />
        </button>
      </div>
      {open && (
        <StepPalette
          clip={clip}
          onPick={(step) => {
            onInsert(step);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * A called module, edited where it is called.
 *
 * Switching scripts to change three steps of a module is the workflow this
 * removes. It has its own draft and its own save button because it *is* another
 * script: saving the caller must not save the module, and vice versa. The
 * warning about other callers is not decoration — editing here changes what
 * they do too.
 */
function ModuleEditor({
  scriptId,
  scripts,
  serial,
  onSaved,
  pick,
  probe,
  clip,
  onCopy,
  onRunHere,
}: {
  scriptId: string;
  scripts: Script[];
  /** Which device the App picker asks about. */
  serial: string;
  onSaved: () => void;
  pick: (mode: PickMode, apply: (r: PickResult) => void) => void;
  probe: (target: TestTarget, path: Path, step: ScriptStep) => void;
  clip: ScriptStep | undefined;
  onCopy: (step: ScriptStep) => void;
  onRunHere: (step: ScriptStep) => void;
}) {
  const stored = scripts.find((s) => s.id === scriptId);
  const [draft, setDraft] = useState<Draft | undefined>(() => localDrafts.get(scriptId) ?? (stored ? asDraft(stored) : undefined));
  const [usedBy, setUsedBy] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fold, setFold] = useState(0);

  useEffect(() => {
    void api<{ usedBy: { id: string; name: string }[] }>(`/api/scripts/${scriptId}/usage`)
      .then((r) => setUsedBy(r.usedBy))
      .catch(() => {});
  }, [scriptId]);

  if (!draft || !stored) return <p className="sp-replay-empty">找不到這個模組</p>;
  const dirty = !isSaved(draft, stored);
  const edit = (update: (d: Draft) => Draft) =>
    setDraft((d) => {
      if (!d) return d;
      const next = update(d);
      localDrafts.set(next.key, next);
      return next;
    });
  const editSteps = (fn: (steps: ScriptStep[]) => ScriptStep[]) => edit((d) => ({ ...d, steps: fn(d.steps) }));

  return (
    <div className="sp-module-edit">
      <div className="sp-module-head">
        <Icon name="package" size={13} />
        <span>{draft.name}</span>
        {dirty && <span className="sp-unsaved">未儲存</span>}
        <span style={{ flex: 1 }} />
        <button
          className={dirty ? "primary" : ""}
          disabled={!dirty || busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void api<Script>("/api/scripts", { method: "POST", body: JSON.stringify(draftBody(draft)) })
              .then((saved) => {
                localDrafts.delete(draft.key);
                void api(`/api/drafts/${encodeURIComponent(draft.key)}`, { method: "DELETE" }).catch(() => {});
                setDraft(asDraft(saved));
                onSaved();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : "儲存失敗"))
              .finally(() => setBusy(false));
          }}
        >
          儲存模組
        </button>
        {dirty && (
          <button
            onClick={() => {
              localDrafts.delete(draft.key);
              setDraft(asDraft(stored));
            }}
          >
            放棄
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {usedBy.length > 0 && (
        <p className="sp-warn-inline">
          <Icon name="copy" size={11} /> {usedBy.length} 支腳本使用這個模組,改動會一起生效:{usedBy.map((u) => u.name).join("、")}
        </p>
      )}
      <VariablesPanel
        variables={draft.variables ?? []}
        onChange={(variables) => edit((d) => ({ ...d, variables }))}
        isModule
      />
      <div className="sp-steps" data-fold={fold}>
        {draft.steps.map((step, i) => (
          <Fragment key={i}>
          <InsertPoint clip={clip} onInsert={(s) => editSteps((prev) => editList(prev, [{ index: i }], insertBefore(s)))} />
          <StepRow
            step={step}
            serial={serial}
            path={[{ index: i }]}
            onChange={(p, next) => editSteps((s) => editList(s, p, replaceAt(next)))}
            onRemove={(p) => editSteps((s) => editList(s, p, removeAt()))}
            onMove={(p, dir) => editSteps((s) => editList(s, p, moveAt(dir)))}
            onAdd={(p, branch, next) => editSteps((s) => editList(s, intoBranch(p, branch), appendTo(next)))}
            onInsert={(p, next) => editSteps((s) => editList(s, p, insertBefore(next)))}
            onCopy={onCopy}
            onCut={(p, cutStep) => {
              onCopy(cutStep);
              editSteps((s) => editList(s, p, removeAt()));
            }}
            onPaste={(p) => clip && editSteps((s) => editList(s, p, insertAfter(structuredClone(clip))))}
            clip={clip}
            pick={pick}
            probe={probe}
            modules={scripts.filter((s) => s.isModule && s.id !== scriptId)}
            variables={draft.variables ?? []}
            labels={labelsInScope(draft.steps, [{ index: i }])}
            inLoop={false}
            isModule
            onRunHere={onRunHere}
            onEditModule={() => setError("模組裡的模組請從腳本清單開啟編輯")}
            editingModule={undefined}
            renderModule={() => null}
            scriptKey={scriptId}
            onFold={() => setFold((n) => n + 1)}
          />
          </Fragment>
        ))}
        <AddMenu onAdd={(step) => editSteps((s) => [...s, step])} clip={clip} />
      </div>
    </div>
  );
}

// ---- panel ----

export function ScriptPanel({ serial, onClose }: { serial: string; onClose: () => void }) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [draft, setDraft] = useState<Draft | undefined>(openDraft);
  /** Which scripts have edits waiting, for the dots in the picker. Keys only —
   * the bodies stay on the server until one is actually opened. */
  const [draftKeys, setDraftKeys] = useState<{ key: string; updatedAt: number }[]>([]);
  /** Shows 已儲存 for a moment after a save; cleared by the next edit. */
  const [justSaved, setJustSaved] = useState(false);
  /** Which called module is open for editing, and a counter that re-renders
   * when a block is folded (the fold state itself lives outside React). */
  const [editingModule, setEditingModule] = useState<string>();
  const [fold, setFold] = useState(0);
  /** Edits the debounce is still sitting on, so closing the panel can flush them. */
  const unsent = useRef<{ key: string; draft: Draft } | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  /** Known devices, so a scheduled script can be pointed at several. */
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  /** Mirrors the module-level clipboard; state only so the paste buttons appear
   * the moment something is copied. */
  const [clip, setClip] = useState<ScriptStep | undefined>(clipboard);
  const [status, setStatus] = useState<ScriptStatus>();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ mode: PickMode; apply: (r: PickResult) => void }>();
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{
    target: TestTarget;
    path: Path;
    selectable: boolean;
    filter?: ScriptFilter;
    pick?: ScriptPick;
    offset?: { x: number; y: number };
  }>();
  /** Set the moment 執行 is clicked so the UI responds before the server does. */
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    // Every script, not this device's — a script is a procedure, and which
    // devices it is scheduled on is a property of the script.
    setScripts(await api<Script[]>("/api/scripts").catch(() => []));
    setDraftKeys(await api<{ key: string; updatedAt: number }[]>("/api/drafts").catch(() => []));
  }, []);

  useEffect(() => {
    void api<DeviceInfo[]>("/api/devices")
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Nothing open yet (a fresh page, or the panel opened for the first time):
  // pick up the most recent unsaved edit rather than making someone hunt for
  // where they were. Only on a cold start — reopening the panel already has it.
  useEffect(() => {
    if (draft || !draftKeys.length) return;
    const latest = [...draftKeys].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    void openKey(latest.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKeys]);

  /** Show a draft: from this page's memory if it has been touched here, else
   * from the server, which is where it lives between reloads. */
  const openKey = async (key: string) => {
    const cached = localDrafts.get(key);
    if (cached) {
      openDraftKey = key;
      setDraft(cached);
      return;
    }
    const stored = await api<{ body: Draft }>(`/api/drafts/${key}`).catch(() => undefined);
    if (!stored) return;
    const restored = { ...stored.body, key };
    localDrafts.set(key, restored);
    openDraftKey = key;
    setDraft(restored);
  };

  /** Every edit goes through here, so the in-memory copy and the on-screen one
   * never disagree. */
  const applyDraft = (update: (current: Draft) => Draft) =>
    setDraft((current) => {
      if (!current) return current;
      const next = update(current);
      localDrafts.set(next.key, next);
      setJustSaved(false);
      return next;
    });

  const show = (next: Draft | undefined) => {
    openDraftKey = next?.key;
    if (next) localDrafts.set(next.key, next);
    setDraft(next);
    setTest(undefined);
    setJustSaved(false);
  };

  const stored = scripts.find((s) => s.id === draft?.id);
  const dirty = !!draft && !isSaved(draft, stored);

  /** Drop a draft everywhere: on screen it is now identical to the script, so
   * keeping it would leave a dot promising edits that are not there. */
  const forget = useCallback(async (key: string) => {
    localDrafts.delete(key);
    sentDrafts.delete(key);
    await api(`/api/drafts/${encodeURIComponent(key)}`, { method: "DELETE" }).catch(() => {});
    setDraftKeys((keys) => keys.filter((k) => k.key !== key));
  }, []);

  // Mirror the draft to the server once editing pauses. Skipped when the body
  // is byte-identical to the last one sent, so idle time costs nothing.
  useEffect(() => {
    if (!draft) return;
    const key = draft.key;
    const body = stableJson(draftBody(draft));
    if (!dirty) {
      if (sentDrafts.has(key)) void forget(key);
      return;
    }
    if (sentDrafts.get(key) === body) return;
    // Remembered outside the timer as well: closing the panel within the pause
    // cancels the timer, and those last edits are the ones most worth keeping.
    unsent.current = { key, draft };
    const timer = setTimeout(() => void syncDraft(), DRAFT_SYNC_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, forget]);

  const syncDraft = async () => {
    const waiting = unsent.current;
    if (!waiting) return;
    try {
      await api(`/api/drafts/${encodeURIComponent(waiting.key)}`, {
        method: "PUT",
        body: JSON.stringify(draftBody(waiting.draft)),
      });
      sentDrafts.set(waiting.key, stableJson(draftBody(waiting.draft)));
      unsent.current = undefined;
      setDraftKeys((keys) =>
        keys.some((k) => k.key === waiting.key) ? keys : [...keys, { key: waiting.key, updatedAt: Date.now() }],
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? `草稿未保留:${e.message}` : "草稿未保留");
    }
  };

  // Closing the panel is not an edit — flush whatever the pause was still
  // holding, so the server copy matches what is on screen.
  useEffect(() => () => void syncDraft(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Put the view back where it was. The steps arrive over a frame or two (the
  // draft loads, template thumbnails decode), so the position is re-applied
  // until it sticks rather than set once against a page that is still short.
  useEffect(() => {
    const el = scroller.current;
    const want = draft && scrollTops.get(draft.key);
    if (!el || !want) return;
    let tries = 0;
    const restore = () => {
      el.scrollTop = want;
      if (++tries < 8 && Math.abs(el.scrollTop - want) > 2) requestAnimationFrame(restore);
    };
    requestAnimationFrame(restore);
  }, [draft?.key]);

  // 已儲存 is an acknowledgement, not a state; the quiet disabled 儲存 button is
  // what says "nothing to save" from then on.
  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  // Poll run status while the panel is open.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api<ScriptStatus>(`/api/devices/${encodeURIComponent(serial)}/script/status`)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    void tick();
    const timer = setInterval(tick, starting ? 300 : 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [serial, starting]);

  const editSteps = (fn: (steps: ScriptStep[]) => ScriptStep[]) =>
    applyDraft((d) => ({ ...d, steps: fn(d.steps) }));

  /** Any edit that moves rows around invalidates the open test dialog: it holds
   * the path of the step it was opened for, and that path now points at
   * whatever took its place. */
  const restructure = (fn: (steps: ScriptStep[]) => ScriptStep[]) => {
    setTest(undefined);
    editSteps(fn);
  };

  /**
   * Run a single block on the device being viewed.
   *
   * The step is sent whole, so it runs exactly as it looks right now — an
   * unsaved script, or an unsaved change to a saved one, is the normal case
   * for trying one block out. Straight to the engine rather than through the
   * scheduler: a check like this should not outrank or queue behind scheduled
   * work.
   */
  const runHere = (step: ScriptStep) => {
    setError(undefined);
    void api(`/api/devices/${encodeURIComponent(serial)}/run-step`, {
      method: "POST",
      body: JSON.stringify({ step, variables: draft?.variables, name: draft?.name }),
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : "執行失敗"));
  };

  const copyStep = (step: ScriptStep) => {
    clipboard = structuredClone(step);
    setClip(clipboard);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api<Script>("/api/scripts", { method: "POST", body: JSON.stringify(draftBody(draft)) });
      // Saved is saved: the draft has nothing left to remember, and a new
      // script's `new:` key is replaced by its real id.
      unsent.current = undefined;
      await forget(draft.key);
      show(asDraft(saved));
      setJustSaved(true);
      await reload();
    } catch (e: unknown) {
      // A script carrying image templates is the one thing here big enough to
      // be refused outright, and that refusal now says something useful. The
      // draft is untouched, so nothing is lost by failing.
      setError(e instanceof Error ? e.message : "儲存失敗");
    } finally {
      setBusy(false);
    }
  };

  /** Back to the saved version, or away entirely for a script that was never
   * saved. Confirmed first: a draft can hold a template that took a marquee to
   * frame, and there is no undo behind this. */
  const discard = async () => {
    if (!draft) return;
    const question = stored ? `放棄「${stored.name}」未儲存的變更?` : `放棄未儲存的「${draft.name}」?`;
    if (!confirm(question)) return;
    await forget(draft.key);
    show(stored ? asDraft(stored) : undefined);
  };

  /** Duplicate what is on screen, unsaved edits and all. The copy keeps the
   * schedule but never inherits an enabled one — two identical daily scripts
   * both firing is nobody's intent. */
  const duplicate = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const copy = {
        ...draftBody(draft),
        id: undefined,
        // The server caps a name at 60 characters and answers 400 past it.
        name: `${draft.name} 複本`.slice(0, 60),
        enabled: draft.trigger.type === "manual" ? draft.enabled : false,
      };
      // The original keeps its draft — copying is not saving what you are
      // looking at, and the copy is a different script from here on.
      show(asDraft(await api<Script>("/api/scripts", { method: "POST", body: JSON.stringify(copy) })));
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "複製失敗");
    } finally {
      setBusy(false);
    }
  };

  const running = status?.state === "running" || status?.state === "stopping";
  /** Already queued for this device — the run button must not invite a re-click. */
  const queued = !!status?.pending;
  const active = running || queued;
  // Stop showing "啟動中" once the server reports it running or explains the wait.
  useEffect(() => {
    if (starting && (running || status?.pending)) setStarting(false);
  }, [starting, running, status?.pending]);

  const waitLabel =
    status?.pending?.reason === "unreachable"
      ? "裝置連不上 — 已排入佇列,裝置回來就會執行"
      : status?.pending?.reason === "humanActive"
        ? "手動操作中,腳本暫讓(停手約 15 秒後自動接手)"
        : status?.pending?.reason === "outranked"
          ? `排隊中:等「${status.scriptName ?? "另一支腳本"}」結束`
          : status?.pending
            ? "排隊中…"
            : undefined;

  const activity = running
    ? `執行中:${status?.scriptName ?? ""}${status?.stepsRun ? ` · 第 ${status.stepsRun} 步` : ""}`
    : starting
      ? "啟動中…"
      : waitLabel;

  return (
    <div
      className="script-panel"
      ref={scroller}
      onScroll={(e) => draft && scrollTops.set(draft.key, e.currentTarget.scrollTop)}
    >
      <div className="sp-head">
        <Icon name="robot" size={18} />
        <span style={{ fontWeight: 600 }}>自動化腳本</span>
        {dirty && <span className="sp-unsaved" title="這些變更還沒儲存,但已經保留著">未儲存</span>}
        <span style={{ flex: 1 }} />
        {active ? (
          <button
            className="sp-run stop"
            onClick={() => void api(`/api/devices/${encodeURIComponent(serial)}/script/stop`, { method: "POST" })}
          >
            <Icon name="stop" size={14} /> 停止
          </button>
        ) : (
          <button
            className="sp-run"
            onClick={() => {
              setError(undefined);
              setStarting(true);
              void api(`/api/devices/${encodeURIComponent(serial)}/scripts/${draft?.id}/run`, { method: "POST" }).catch((e: unknown) => {
                setStarting(false);
                setError(e instanceof Error ? e.message : "執行失敗");
              });
            }}
            disabled={!draft?.id || busy || starting}
          >
            <Icon name="play" size={14} /> {starting ? "啟動中…" : "執行"}
          </button>
        )}
        <button onClick={onClose} title="關閉">✕</button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {dirty && draft?.id && !active && (
        <p className="sp-warn-inline">執行的是已儲存的版本 — 要跑畫面上的內容請先儲存</p>
      )}
      {activity && (
        <div className={`sp-activity${running ? " run" : ""}`}>
          <span className="sp-dot" />
          {activity}
        </div>
      )}

      <div className="sp-scripts">
        <select
          value={draft?.id ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            if (!id) return show(undefined);
            // A script with edits waiting opens at those edits, not at the
            // saved version — that is what the dot beside it promises.
            if (draftKeys.some((k) => k.key === id)) return void openKey(id);
            const found = scripts.find((s) => s.id === id);
            show(found ? asDraft(found) : undefined);
          }}
        >
          <option value="">— 選擇腳本 —</option>
          {[
            { label: "腳本", items: scripts.filter((s) => !s.isModule) },
            { label: "模組", items: scripts.filter((s) => s.isModule) },
          ]
            .filter((group) => group.items.length)
            .map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {draftKeys.some((k) => k.key === s.id) ? `● ${s.name}` : s.name}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <button onClick={() => show(newDraft(serial))}>新建</button>
        {draft && (
          <button
            title={draft.trigger.type === "manual" ? "複製成另一支腳本" : "複製成另一支腳本(複本的排程不會啟用)"}
            disabled={busy}
            onClick={() => void duplicate()}
          >
            <Icon name="copy" size={13} />
          </button>
        )}
        {draft?.id && (
          <button
            title="刪除腳本"
            onClick={async () => {
              await api(`/api/scripts/${draft.id}`, { method: "DELETE" }).catch(() => {});
              show(undefined);
              await reload();
            }}
          >
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>

      {draft && (
        <>
          <div className="sp-name">
            <input value={draft.name} onChange={(e) => applyDraft((d) => ({ ...d, name: e.target.value }))} placeholder="腳本名稱" />
            {dirty && (
              <button title="放棄未儲存的變更" disabled={busy} onClick={() => void discard()}>
                <Icon name="undo" size={13} />
              </button>
            )}
            <button
              className={dirty ? "primary" : justSaved ? "saved" : ""}
              disabled={busy || !dirty}
              onClick={() => void save()}
              title={dirty ? "儲存到伺服器" : justSaved ? "已儲存" : "沒有未儲存的變更"}
            >
              {justSaved && !dirty ? (
                <>
                  <Icon name="check" size={13} /> 已儲存
                </>
              ) : (
                "儲存"
              )}
            </button>
          </div>

          <VariablesPanel
            variables={draft.variables ?? []}
            onChange={(variables) => applyDraft((d) => ({ ...d, variables }))}
            isModule={!!draft.isModule}
          />

          <div className="sp-sched">
            <label className="sp-enable" title="模組由其他腳本呼叫,不進排程">
              <input
                type="checkbox"
                checked={!!draft.isModule}
                onChange={(e) => applyDraft((d) => ({ ...d, isModule: e.target.checked || undefined }))}
              />
              模組
            </label>
            {!draft.isModule && (
            <select
              value={draft.trigger.type}
              onChange={(e) => {
                const type = e.target.value as ScriptTrigger["type"];
                applyDraft((d) => ({ ...d, trigger: type === "daily" ? { type, time: "09:00" } : { type } }));
              }}
            >
              <option value="manual">手動</option>
              <option value="persistent">常駐</option>
              <option value="daily">每日</option>
            </select>
            )}
            {draft.trigger.type === "daily" && (
              <input
                type="time"
                value={draft.trigger.time}
                onChange={(e) => applyDraft((d) => ({ ...d, trigger: { type: "daily", time: e.target.value } }))}
              />
            )}
            <select value={draft.priority} onChange={(e) => applyDraft((d) => ({ ...d, priority: Number(e.target.value) }))}>
              {PRIORITY_LABELS.map((p) => (
                <option key={p.value} value={p.value}>優先 {p.label}</option>
              ))}
            </select>
            {draft.trigger.type !== "manual" && (
              <label className="sp-enable">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => applyDraft((d) => ({ ...d, enabled: e.target.checked }))} />
                啟用
              </label>
            )}
          </div>

          {draft.trigger.type !== "manual" && (
            <div className="sp-devices">
              <span className="muted">排程在</span>
              {devices.length === 0 && <span className="muted">(沒有已知裝置)</span>}
              {devices.map((d) => (
                <label key={d.serial} title={d.serial}>
                  <input
                    type="checkbox"
                    checked={draft.devices.includes(d.serial)}
                    onChange={(e) =>
                      applyDraft((current) => ({
                        ...current,
                        devices: e.target.checked
                          ? [...current.devices, d.serial]
                          : current.devices.filter((x) => x !== d.serial),
                      }))
                    }
                  />
                  {d.name || d.serial}
                  {d.serial === serial && <span className="muted"> (目前)</span>}
                </label>
              ))}
              {!draft.devices.length && <span className="sp-warn-inline">未選裝置 — 排程不會執行</span>}
            </div>
          )}

          <div className="sp-steps">
            {draft.steps.map((step, i) => (
              <Fragment key={i}>
              <InsertPoint clip={clip} onInsert={(s) => restructure((prev) => editList(prev, [{ index: i }], insertBefore(s)))} />
              <StepRow
                step={step}
                serial={serial}
                path={[{ index: i }]}
                onChange={(p, next) => editSteps((s) => editList(s, p, replaceAt(next)))}
                onRemove={(p) => restructure((s) => editList(s, p, removeAt()))}
                onMove={(p, dir) => restructure((s) => editList(s, p, moveAt(dir)))}
                onAdd={(p, branch, step) => editSteps((s) => editList(s, intoBranch(p, branch), appendTo(step)))}
                onInsert={(p, next) => restructure((s) => editList(s, p, insertBefore(next)))}
                onCopy={copyStep}
                onCut={(p, cutStep) => {
                  copyStep(cutStep);
                  restructure((s) => editList(s, p, removeAt()));
                }}
                onPaste={(p) => clip && restructure((s) => editList(s, p, insertAfter(structuredClone(clip))))}
                clip={clip}
                modules={scripts.filter((s) => s.isModule && s.id !== draft.id)}
                variables={draft.variables ?? []}
                labels={labelsInScope(draft.steps, [{ index: i }])}
                inLoop={insideLoop(draft.steps, [{ index: i }])}
                isModule={!!draft.isModule}
                onRunHere={runHere}
                onEditModule={(id) => setEditingModule((current) => (current === id ? undefined : id))}
                editingModule={editingModule}
                renderModule={(id) => (
                  <ModuleEditor
                    scriptId={id}
                    scripts={scripts}
                    serial={serial}
                    onSaved={() => void reload()}
                    pick={(mode, apply) => setPicker({ mode, apply })}
                    probe={(target, path, step) =>
                      setTest({ target, path, selectable: step.type === "tapText" || step.type === "findTap" })
                    }
                    clip={clip}
                    onCopy={copyStep}
                    onRunHere={runHere}
                  />
                )}
                scriptKey={draft.key}
                onFold={() => setFold((n) => n + 1)}
                pick={(mode, apply) => setPicker({ mode, apply })}
                probe={(target, path, step) =>
                  setTest({
                    target,
                    path,
                    selectable: step.type === "tapText" || step.type === "findTap",
                    filter: "filter" in step ? step.filter : undefined,
                    pick: "pick" in step ? step.pick : undefined,
                    offset:
                      "offsetX" in step && (step.offsetX || step.offsetY)
                        ? { x: step.offsetX ?? 0, y: step.offsetY ?? 0 }
                        : undefined,
                  })
                }
              />
              </Fragment>
            ))}
            <AddMenu onAdd={(step) => editSteps((s) => [...s, step])} clip={clip} />
          </div>

        </>
      )}

      {status && status.log.length > 0 && (
        <div className="sp-log">
          <div className="sp-log-head">
            執行紀錄 <span className="muted">{status.scriptName} · {status.state === "running" ? "執行中" : status.state === "stopping" ? "停止中" : "已結束"}</span>
          </div>
          {status.log.slice(-40).map((entry, i) => (
            <div key={i}>
              {new Date(entry.at).toLocaleTimeString()} {entry.message}
            </div>
          ))}
        </div>
      )}

      {test && (
        <TestPreview
          serial={serial}
          target={test.target}
          onClose={() => setTest(undefined)}
          onSuggestThreshold={
            test.target.kind === "match"
              ? (value) => {
                  editSteps((s) => editList(s, test.path, (list, i) =>
                    list.map((step, j) => (j === i ? ({ ...step, threshold: value } as ScriptStep) : step)),
                  ));
                  setTest(undefined);
                }
              : undefined
          }
          filter={test.filter}
          pick={test.pick}
          offset={test.offset}
          onOffsetChange={
            test.selectable
              ? (offset) => {
                  editSteps((s) => editList(s, test.path, (list, i) =>
                    list.map((step, j) =>
                      j === i ? ({ ...step, offsetX: offset?.x, offsetY: offset?.y } as ScriptStep) : step,
                    ),
                  ));
                  setTest({ ...test, offset });
                }
              : undefined
          }
          onChange={
            test.selectable
              ? (filter, pick) => {
                  editSteps((s) => editList(s, test.path, (list, i) =>
                    list.map((step, j) => (j === i ? ({ ...step, filter, pick } as ScriptStep) : step)),
                  ));
                  // The probe already holds every candidate, so re-filtering is
                  // instant — keep the modal on the same frame.
                  setTest({ ...test, filter, pick });
                }
              : undefined
          }
        />
      )}

      {picker && (
        <Picker
          serial={serial}
          mode={picker.mode}
          onPick={picker.apply}
          onClose={() => setPicker(undefined)}
        />
      )}
    </div>
  );
}
