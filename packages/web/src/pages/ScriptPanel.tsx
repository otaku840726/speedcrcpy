import { PRIORITY_LABELS, type Script, type ScriptKey, type ScriptStatus, type ScriptStep, type ScriptTemplate, type ScriptTrigger } from "@speedcrcpy/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";
import { TestPreview, type TestTarget } from "./TestPreview";

/** Where a step lives in the (nested) tree: child indexes plus which branch. */
type Path = { index: number; branch?: "body" | "then" | "else" }[];

const KEY_LABELS: Record<string, string> = {
  back: "返回",
  home: "主畫面",
  recents: "多工",
  power: "電源",
  wake: "喚醒",
  volumeUp: "音量+",
  volumeDown: "音量-",
};

const NEW_STEPS: { label: string; make: () => ScriptStep; key: boolean }[] = [
  { label: "找圖點擊", key: true, make: () => ({ type: "findTap", template: EMPTY_TEMPLATE(), threshold: 0.85, timeoutMs: 8000 }) },
  { label: "若找到圖", key: true, make: () => ({ type: "ifImage", template: EMPTY_TEMPLATE(), threshold: 0.85, then: [], else: [] }) },
  { label: "依文字點擊", key: true, make: () => ({ type: "tapText", text: "", timeoutMs: 8000 }) },
  { label: "若文字含", key: true, make: () => ({ type: "ifText", text: "", then: [], else: [] }) },
  { label: "讀取數值", key: true, make: () => ({ type: "ifNumber", compare: ">", value: 0, then: [], else: [] }) },
  { label: "點擊", key: false, make: () => ({ type: "tap", x: 0.5, y: 0.5 }) },
  { label: "滑動", key: false, make: () => ({ type: "swipe", x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3, durationMs: 300 }) },
  { label: "等待", key: false, make: () => ({ type: "wait", minMs: 500, maxMs: 500 }) },
  { label: "等待顏色", key: false, make: () => ({ type: "waitColor", x: 0.5, y: 0.5, color: "#ffffff", tolerance: 0.1, timeoutMs: 8000 }) },
  { label: "若顏色", key: false, make: () => ({ type: "ifColor", x: 0.5, y: 0.5, color: "#ffffff", tolerance: 0.1, then: [], else: [] }) },
  { label: "重複", key: false, make: () => ({ type: "loop", count: 0, body: [] }) },
  { label: "輸入文字", key: false, make: () => ({ type: "text", value: "" }) },
  { label: "按鍵", key: false, make: () => ({ type: "key", key: "back" }) },
];

function EMPTY_TEMPLATE(): ScriptTemplate {
  return { png: "", capturedWidth: 0, capturedHeight: 0 };
}

// ---- immutable tree edits ----

function childrenOf(step: ScriptStep, branch: "body" | "then" | "else"): ScriptStep[] {
  const anyStep = step as unknown as Record<string, ScriptStep[] | undefined>;
  return anyStep[branch] ?? [];
}

function withChildren(step: ScriptStep, branch: "body" | "then" | "else", children: ScriptStep[]): ScriptStep {
  return { ...step, [branch]: children } as ScriptStep;
}

/** Apply `edit` to the child list that `path` points into. */
function editList(steps: ScriptStep[], path: Path, edit: (list: ScriptStep[], index: number) => ScriptStep[]): ScriptStep[] {
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
const intoBranch = (path: Path, branch: "body" | "then" | "else"): Path => [
  ...path.slice(0, -1),
  { index: path[path.length - 1]!.index, branch },
];

const replaceAt = (next: ScriptStep) => (list: ScriptStep[], i: number) => list.map((s, j) => (j === i ? next : s));
const removeAt = () => (list: ScriptStep[], i: number) => list.filter((_, j) => j !== i);
const appendTo = (step: ScriptStep) => (list: ScriptStep[]) => [...list, step];
const moveAt = (dir: -1 | 1) => (list: ScriptStep[], i: number) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

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
  const [test, setTest] = useState<{ target: TestTarget; path: Path }>();
  /** Set the moment 執行 is clicked so the UI responds before the server does. */
  const [starting, setStarting] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

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
    onPick({
      x: (x + w / 2) / canvas.width,
      y: (y + h / 2) / canvas.height,
      color: colorAt((x + w / 2) / canvas.width, (y + h / 2) / canvas.height),
      template: {
        png: crop.toDataURL("image/png").split(",")[1] ?? "",
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
          <span>{hint}</span>
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
  onChange,
  onRemove,
  onMove,
  onAdd,
  pick,
  probe,
}: {
  step: ScriptStep;
  path: Path;
  onChange: (path: Path, next: ScriptStep) => void;
  onRemove: (path: Path) => void;
  onMove: (path: Path, dir: -1 | 1) => void;
  onAdd: (path: Path, branch: "body" | "then" | "else", step: ScriptStep) => void;
  pick: (mode: PickMode, apply: (r: PickResult) => void) => void;
  probe: (target: TestTarget, path: Path) => void;
}) {
  const set = (patch: Partial<ScriptStep>) => onChange(path, { ...step, ...patch } as ScriptStep);
  const num = (v: string) => Number(v) || 0;

  const coordChip = (x: number, y: number, apply: (r: PickResult) => void) => (
    <button className="sp-pick" onClick={() => pick("point", apply)} title="從畫面拾取">
      <Icon name="crosshair" size={13} /> {x.toFixed(2)}, {y.toFixed(2)}
    </button>
  );

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
          相似度 <input className="sp-num" value={Math.round(step.threshold * 100)} onChange={(e) => set({ threshold: num(e.target.value) / 100 })} />%
          <button
            className="sp-probe"
            disabled={!step.template.png}
            onClick={() => probe({ kind: "match", region: step.region, template: step.template, threshold: step.threshold }, path)}
            title={step.template.png ? "測試:看比對到哪裡、相似度多少" : "請先框選圖像"}
          >
            測試
          </button>
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
      const regionChip = (
        <button
          className={`sp-pick${step.region ? "" : " warn"}`}
          onClick={() => pick("region", (r) => r.region && set({ region: r.region }))}
          title={step.region ? "重新框選辨識範圍" : "未框選範圍:整張畫面(慢約 30 倍,座標較粗略)"}
        >
          <Icon name="crosshair" size={13} />
          {step.region
            ? `${(step.region.w * 100).toFixed(0)}×${(step.region.h * 100).toFixed(0)}%`
            : "整張(慢)"}
        </button>
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
              onClick={() => probe({ kind: "ocr", region: step.region, text: step.text }, path)}
              title="測試:看實際讀到什麼、會點在哪裡"
            >
              測試
            </button>
            {step.type === "tapText" && (
              <>
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
      : step.type === "ifColor" || step.type === "ifImage" || step.type === "ifText" || step.type === "ifNumber"
        ? ["then", "else"]
        : [];

  return (
    <div className={`sp-step${branches.length ? " sp-block" : ""}`}>
      <div className="sp-line">
        <span className="sp-body">{body}</span>
        <span className="sp-actions">
          <button onClick={() => onMove(path, -1)} title="上移"><Icon name="arrowUp" size={12} /></button>
          <button onClick={() => onMove(path, 1)} title="下移"><Icon name="arrowDown" size={12} /></button>
          <button onClick={() => onRemove(path)} title="刪除"><Icon name="trash" size={12} /></button>
        </span>
      </div>
      {branches.map((branch) => (
        <div key={branch} className={`sp-branch sp-branch-${branch}`}>
          {branches.length > 1 && <div className="sp-branch-label">{branch === "then" ? "成立" : "否則"}</div>}
          {childrenOf(step, branch).map((child, i) => (
            <StepRow
              key={i}
              step={child}
              path={[...intoBranch(path, branch), { index: i }]}
              onChange={onChange}
              onRemove={onRemove}
              onMove={onMove}
              onAdd={onAdd}
              pick={pick}
              probe={probe}
            />
          ))}
          <AddMenu onAdd={(s) => onAdd(path, branch, s)} />
        </div>
      ))}
    </div>
  );
}

function AddMenu({ onAdd }: { onAdd: (step: ScriptStep) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sp-add">
      <button className="sp-add-btn" onClick={() => setOpen((v) => !v)}>
        <Icon name="plus" size={12} /> 新增步驟
      </button>
      {open && (
        <div className="sp-palette">
          {NEW_STEPS.map((s) => (
            <button
              key={s.label}
              className={s.key ? "sp-chip key" : "sp-chip"}
              onClick={() => {
                onAdd(s.make());
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- panel ----

export function ScriptPanel({ serial, onClose }: { serial: string; onClose: () => void }) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [draft, setDraft] = useState<{ id?: string; name: string; steps: ScriptStep[]; trigger: ScriptTrigger; priority: number; enabled: boolean }>();
  const [status, setStatus] = useState<ScriptStatus>();
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ mode: PickMode; apply: (r: PickResult) => void }>();
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{ target: TestTarget; path: Path }>();
  /** Set the moment 執行 is clicked so the UI responds before the server does. */
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    setScripts(await api<Script[]>(`/api/devices/${encodeURIComponent(serial)}/scripts`).catch(() => []));
  }, [serial]);

  useEffect(() => {
    void reload();
  }, [reload]);

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
    setDraft((d) => (d ? { ...d, steps: fn(d.steps) } : d));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await api<Script>(`/api/devices/${encodeURIComponent(serial)}/scripts`, {
        method: "POST",
        body: JSON.stringify(draft),
      });
      setDraft({ id: saved.id, name: saved.name, steps: saved.steps, trigger: saved.trigger, priority: saved.priority, enabled: saved.enabled });
      await reload();
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
    status?.pending?.reason === "humanActive"
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
    <div className="script-panel">
      <div className="sp-head">
        <Icon name="robot" size={18} />
        <span style={{ fontWeight: 600 }}>自動化腳本</span>
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
              void api(`/api/scripts/${draft?.id}/run`, { method: "POST" }).catch((e: unknown) => {
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
            const found = scripts.find((s) => s.id === e.target.value);
            setDraft(found ? { id: found.id, name: found.name, steps: found.steps, trigger: found.trigger, priority: found.priority, enabled: found.enabled } : undefined);
          }}
        >
          <option value="">— 選擇腳本 —</option>
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <button onClick={() => setDraft({ name: "新腳本", steps: [], trigger: { type: "manual" }, priority: 20, enabled: true })}>新建</button>
        {draft?.id && (
          <button
            title="刪除腳本"
            onClick={async () => {
              await api(`/api/scripts/${draft.id}`, { method: "DELETE" }).catch(() => {});
              setDraft(undefined);
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
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="腳本名稱" />
            <button className="primary" disabled={busy} onClick={() => void save()}>儲存</button>
          </div>

          <div className="sp-sched">
            <select
              value={draft.trigger.type}
              onChange={(e) => {
                const type = e.target.value as ScriptTrigger["type"];
                setDraft({ ...draft, trigger: type === "daily" ? { type, time: "09:00" } : { type } });
              }}
            >
              <option value="manual">手動</option>
              <option value="persistent">常駐</option>
              <option value="daily">每日</option>
            </select>
            {draft.trigger.type === "daily" && (
              <input
                type="time"
                value={draft.trigger.time}
                onChange={(e) => setDraft({ ...draft, trigger: { type: "daily", time: e.target.value } })}
              />
            )}
            <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>
              {PRIORITY_LABELS.map((p) => (
                <option key={p.value} value={p.value}>優先 {p.label}</option>
              ))}
            </select>
            {draft.trigger.type !== "manual" && (
              <label className="sp-enable">
                <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                啟用
              </label>
            )}
          </div>

          <div className="sp-steps">
            {draft.steps.map((step, i) => (
              <StepRow
                key={i}
                step={step}
                path={[{ index: i }]}
                onChange={(p, next) => editSteps((s) => editList(s, p, replaceAt(next)))}
                onRemove={(p) => editSteps((s) => editList(s, p, removeAt()))}
                onMove={(p, dir) => editSteps((s) => editList(s, p, moveAt(dir)))}
                onAdd={(p, branch, step) => editSteps((s) => editList(s, intoBranch(p, branch), appendTo(step)))}
                pick={(mode, apply) => setPicker({ mode, apply })}
                probe={(target, path) => setTest({ target, path })}
              />
            ))}
            <AddMenu onAdd={(step) => editSteps((s) => [...s, step])} />
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
