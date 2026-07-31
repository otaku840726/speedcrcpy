import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";

/** Mirrors the server's replay-store shapes; only what the player reads. */
interface ReplaySummary {
  runId: string;
  scriptName: string;
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "done" | "stopped" | "error";
  frames: number;
  bytes: number;
}
interface ReplayIndex extends ReplaySummary {
  width: number;
  height: number;
  shots: { at: number }[];
  log: { at: number; message: string }[];
}
interface ReplaySettings {
  enabled: boolean;
  intervalSec: number;
  maxMb: number;
}

/**
 * Speeds are multipliers on real time, not on frame count: at 4× a three-minute
 * run takes 45 seconds and the gaps where the script wasn't looking at the
 * screen stay proportionally long. 最快 is the other thing people want — one
 * frame after another, gaps removed — so it is a fixed interval instead.
 */
const SPEEDS = [4, 8, 0] as const;
const SPEED_LABELS: Record<number, string> = { 4: "4×", 8: "8×", 0: "最快" };
const FLAT_OUT_MS = 120;
/**
 * Ceiling on how long one frame may hold the screen, however long the gap was.
 * A step that needs no picture leaves a hole in the recording — a minute of
 * waiting is one frame — and honouring that literally at 4× is fifteen seconds
 * of a still image, which reads as broken rather than as slow. Past this the
 * playback is no longer proportional, which is the right trade for a timelapse.
 */
const MAX_HOLD_MS = 1500;

const OUTCOME_LABELS: Record<ReplaySummary["outcome"], string> = {
  running: "執行中",
  done: "完成",
  stopped: "已停止",
  error: "錯誤",
};

const clock = (at: number) => new Date(at).toLocaleTimeString();
const duration = (run: ReplaySummary) => {
  const ms = (run.endedAt ?? Date.now()) - run.startedAt;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
};
const day = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? "今天" : d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;

/**
 * A run played back from the screenshots it took anyway.
 *
 * Not a video: there is no encoder on the server and no ffmpeg, so this is the
 * frames themselves, paced in the browser. Good enough to answer "what was on
 * screen when it went wrong", which is what a replay is for.
 */
export function ReplayPlayer({ scriptId, live }: { scriptId: string; live: boolean }) {
  const [runs, setRuns] = useState<ReplaySummary[]>([]);
  const [settings, setSettings] = useState<ReplaySettings>();
  const [used, setUsed] = useState(0);
  const [runId, setRunId] = useState<string>();
  const [index, setIndex] = useState<ReplayIndex>();
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(4);
  const [showSettings, setShowSettings] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadRuns = useCallback(async () => {
    const res = await api<{ runs: ReplaySummary[]; usedBytes: number; settings: ReplaySettings }>(
      `/api/replays?scriptId=${encodeURIComponent(scriptId)}`,
    ).catch(() => undefined);
    if (!res) return;
    setRuns(res.runs);
    setUsed(res.usedBytes);
    setSettings(res.settings);
    setRunId((current) => (current && res.runs.some((r) => r.runId === current) ? current : res.runs[0]?.runId));
  }, [scriptId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  // A run in progress grows; keep asking so 邊跑邊看 shows the newest frames
  // instead of whatever existed when the panel opened.
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => void loadRuns(), 3000);
    return () => clearInterval(poll);
  }, [live, loadRuns]);

  const loadIndex = useCallback(async () => {
    if (!runId) return setIndex(undefined);
    const next = await api<ReplayIndex>(`/api/replays/${runId}`).catch(() => undefined);
    if (next) setIndex(next);
  }, [runId]);

  useEffect(() => {
    setAt(0);
    void loadIndex();
  }, [loadIndex]);

  const shots = index?.shots ?? [];
  const running = index?.outcome === "running";

  // Refresh the frame list of a run that is still going.
  useEffect(() => {
    if (!running) return;
    const poll = setInterval(() => void loadIndex(), 3000);
    return () => clearInterval(poll);
  }, [running, loadIndex]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing || !shots.length) return;
    if (at >= shots.length - 1) {
      setPlaying(false);
      return;
    }
    const gap = shots[at + 1]!.at - shots[at]!.at;
    const hold = speed === 0 ? FLAT_OUT_MS : Math.min(MAX_HOLD_MS, Math.max(30, gap / speed));
    timer.current = setTimeout(() => setAt((n) => n + 1), hold);
    return () => clearTimeout(timer.current);
  }, [playing, at, shots, speed]);

  /** The log line that was most recently written when this frame was taken —
   * what the script had just done, next to what the screen looked like. */
  const caption = useMemo(() => {
    const shot = shots[at];
    if (!shot || !index?.log.length) return undefined;
    let last: string | undefined;
    for (const entry of index.log) {
      if (entry.at > shot.at) break;
      last = entry.message;
    }
    return last;
  }, [shots, at, index]);

  const saveSettings = async (patch: Partial<ReplaySettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    const saved = await api<ReplaySettings & { usedBytes: number }>("/api/replays/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: next.enabled, intervalSec: next.intervalSec, maxMb: next.maxMb }),
    }).catch(() => undefined);
    if (saved) setUsed(saved.usedBytes);
    await loadRuns();
  };

  const selected = runs.find((r) => r.runId === runId);

  return (
    <div className="sp-replay">
      <div className="sp-replay-head">
        <Icon name="play" size={13} />
        回放
        {runs.length > 0 && (
          <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {day(run.startedAt)} {clock(run.startedAt)} · {duration(run)} · {OUTCOME_LABELS[run.outcome]} · {run.frames} 張
              </option>
            ))}
          </select>
        )}
        <span style={{ flex: 1 }} />
        <button className="sp-replay-cog" title="錄製設定" onClick={() => setShowSettings((v) => !v)}>
          <Icon name="motherboard" size={13} />
        </button>
      </div>

      {showSettings && settings && (
        <div className="sp-replay-settings">
          <label>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => void saveSettings({ enabled: e.target.checked })} />
            錄下執行過程供回放
          </label>
          <div>
            最密
            <select value={settings.intervalSec} onChange={(e) => void saveSettings({ intervalSec: Number(e.target.value) })}>
              <option value={1}>每 1 秒一張</option>
              <option value={2}>每 2 秒一張</option>
              <option value={5}>每 5 秒一張</option>
              <option value={15}>每 15 秒一張</option>
            </select>
          </div>
          <div>
            上限
            <select value={settings.maxMb} onChange={(e) => void saveSettings({ maxMb: Number(e.target.value) })}>
              {[100, 200, 500, 1000].map((v) => (
                <option key={v} value={v}>{v} MB</option>
              ))}
            </select>
            <span className="muted">已用 {mb(used)} · 共 {runs.length} 次</span>
          </div>
          <span className="muted">
            只存腳本本來就擷取的畫面,不會為了錄影多截一次螢幕 — 純等待的步驟因此沒有畫面。
          </span>
        </div>
      )}

      {!selected || !shots.length ? (
        <p className="sp-replay-empty">
          {settings && !settings.enabled
            ? "回放錄製已關閉"
            : runs.length
              ? "這次執行還沒有錄到畫面"
              : "這支腳本還沒有錄到的執行 — 執行一次之後,這裡會出現當時的畫面"}
        </p>
      ) : (
        <>
          <div className="sp-replay-stage" style={{ aspectRatio: `${index?.width || 9} / ${index?.height || 16}` }}>
            <img src={`/api/replays/${selected.runId}/frames/${at}`} alt="" />
            {/* Next frame fetched while this one is on screen, so playback does
                not flash white between frames on a slow link. */}
            {at + 1 < shots.length && (
              <img className="sp-replay-preload" src={`/api/replays/${selected.runId}/frames/${at + 1}`} alt="" />
            )}
          </div>

          <input
            className="sp-replay-scrub"
            type="range"
            min={0}
            max={Math.max(0, shots.length - 1)}
            value={at}
            onChange={(e) => {
              setPlaying(false);
              setAt(Number(e.target.value));
            }}
          />

          <div className="sp-replay-controls">
            <button onClick={() => setPlaying((v) => !v)} title={playing ? "暫停" : "播放"}>
              <Icon name={playing ? "stop" : "play"} size={13} />
            </button>
            {SPEEDS.map((s) => (
              <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>
                {SPEED_LABELS[s]}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <span className="muted">
              {at + 1}/{shots.length} · {clock(shots[at]?.at ?? selected.startedAt)}
            </span>
          </div>

          {caption && <div className="sp-replay-caption">{caption}</div>}
          {running && (
            <div className="sp-replay-live">
              <span className="sp-dot" /> 執行中 · 已錄 {shots.length} 張
            </div>
          )}
        </>
      )}
    </div>
  );
}
