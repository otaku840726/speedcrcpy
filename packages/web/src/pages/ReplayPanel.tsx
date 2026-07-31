import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";

interface ReplayEvent {
  at: number;
  message: string;
  scriptName: string;
}
interface ReplayWindow {
  shots: { at: number }[];
  events: ReplayEvent[];
  first: number | null;
  last: number | null;
  settings: ReplaySettings;
  usedBytes: number;
}
interface ReplaySettings {
  enabled: boolean;
  intervalSec: number;
  maxMb: number;
}

/**
 * Speeds are multipliers on real time, not on frame count: at 60× an hour of
 * idle device takes a minute and a busy stretch still takes proportionally
 * longer. 最快 is the other thing people want — frame after frame, gaps gone.
 */
const SPEEDS = [30, 60, 240, 0] as const;
const SPEED_LABELS: Record<number, string> = { 30: "30×", 60: "60×", 240: "240×", 0: "最快" };
const FLAT_OUT_MS = 100;
/**
 * Ceiling on how long one frame may hold the screen. Idle frames are ten
 * seconds apart and a device can sit untouched for hours; honouring that
 * literally would be a still image for minutes, which reads as broken rather
 * than as slow.
 */
const MAX_HOLD_MS = 1200;

const RANGES = [
  { label: "最近 1 小時", ms: 3600_000 },
  { label: "最近 6 小時", ms: 6 * 3600_000 },
  { label: "最近 24 小時", ms: 24 * 3600_000 },
  { label: "全部", ms: 0 },
] as const;

const clock = (at: number) => new Date(at).toLocaleTimeString();
const stamp = (at: number) => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${d.getMonth() + 1}/${d.getDate()} `}${clock(at)}`;
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
const span = (from: number, to: number) => {
  const h = (to - from) / 3600_000;
  return h >= 24 ? `${(h / 24).toFixed(1)} 天` : h >= 1 ? `${h.toFixed(1)} 小時` : `${Math.round(h * 60)} 分鐘`;
};

/**
 * The device's own timelapse.
 *
 * Nothing is captured for it: the thumbnail cache screencaps every connected
 * device on a timer, and a running script screencaps far more often — both
 * frames land here. So the recording exists whether or not anything is
 * automating the phone, and a script only makes it denser and adds the lines it
 * logged, shown against the picture from that moment.
 */
export function ReplayPanel({ serial, onClose }: { serial: string; onClose: () => void }) {
  const [data, setData] = useState<ReplayWindow>();
  const [rangeMs, setRangeMs] = useState<number>(3600_000);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(60);
  const [showSettings, setShowSettings] = useState(false);
  const [follow, setFollow] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    const to = Date.now();
    const from = rangeMs ? to - rangeMs : 0;
    const next = await api<ReplayWindow>(
      `/api/devices/${encodeURIComponent(serial)}/replay?from=${from}&to=${to}`,
    ).catch(() => undefined);
    if (next) setData(next);
  }, [serial, rangeMs]);

  useEffect(() => {
    void load();
  }, [load]);

  // The recording grows while the panel is open — one frame every ten seconds
  // when the device is idle, more while a script runs.
  useEffect(() => {
    const poll = setInterval(() => void load(), 10_000);
    return () => clearInterval(poll);
  }, [load]);

  const shots = data?.shots ?? [];

  // Pin to the newest frame until the scrubber is touched: opening the panel is
  // usually asking "what is it doing now", not "what happened an hour ago".
  useEffect(() => {
    if (follow && shots.length) setAt(shots.length - 1);
  }, [follow, shots.length]);

  // Warm the next frame in the browser cache so playback does not flash white
  // between frames on a slow link. Deliberately not a hidden <img> in the
  // stage: it takes part in layout however it is hidden, and the frame ends up
  // drawn beside the one being watched.
  useEffect(() => {
    const next = shots[at + 1];
    if (!next) return;
    new Image().src = `/api/devices/${encodeURIComponent(serial)}/replay/${next.at}`;
  }, [shots, at, serial]);

  useEffect(() => {
    clearTimeout(timer.current);
    if (!playing || !shots.length) return;
    if (at >= shots.length - 1) {
      setPlaying(false);
      return;
    }
    const gap = shots[at + 1]!.at - shots[at]!.at;
    timer.current = setTimeout(
      () => setAt((n) => n + 1),
      speed === 0 ? FLAT_OUT_MS : Math.min(MAX_HOLD_MS, Math.max(30, gap / speed)),
    );
    return () => clearTimeout(timer.current);
  }, [playing, at, shots, speed]);

  /** The most recent script line at or before this frame, and only while it is
   * recent enough to be about this picture — an event from an hour ago is not a
   * caption for what is on screen now. */
  const caption = useMemo(() => {
    const shot = shots[at];
    if (!shot || !data?.events.length) return undefined;
    let last: ReplayEvent | undefined;
    for (const event of data.events) {
      if (event.at > shot.at) break;
      last = event;
    }
    return last && shot.at - last.at < 120_000 ? last : undefined;
  }, [shots, at, data]);

  /** Where script activity sits on the scrubber, so a run is findable in an
   * otherwise featureless hour of idle frames. */
  const ticks = useMemo(() => {
    if (!shots.length || !data?.events.length) return [];
    const first = shots[0]!.at;
    const last = shots.at(-1)!.at;
    const width = Math.max(1, last - first);
    return data.events.map((e) => ((e.at - first) / width) * 100).filter((p) => p >= 0 && p <= 100);
  }, [shots, data]);

  const saveSettings = async (patch: Partial<ReplaySettings>) => {
    if (!data) return;
    const next = { ...data.settings, ...patch };
    setData({ ...data, settings: next });
    await api("/api/replays/settings", { method: "PUT", body: JSON.stringify(next) }).catch(() => {});
    await load();
  };

  const current = shots[at];

  return (
    <div className="script-panel">
      <div className="sp-head">
        <Icon name="history" size={18} />
        <span style={{ fontWeight: 600 }}>回放</span>
        <select value={rangeMs} onChange={(e) => setRangeMs(Number(e.target.value))}>
          {RANGES.map((r) => (
            <option key={r.label} value={r.ms}>{r.label}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button className="sp-replay-cog" title="錄製設定" onClick={() => setShowSettings((v) => !v)}>
          <Icon name="motherboard" size={14} />
        </button>
        <button onClick={onClose} title="關閉">✕</button>
      </div>

      {showSettings && data && (
        <div className="sp-replay-settings">
          <label>
            <input
              type="checkbox"
              checked={data.settings.enabled}
              onChange={(e) => void saveSettings({ enabled: e.target.checked })}
            />
            錄下畫面供回放
          </label>
          <div>
            最密
            <select
              value={data.settings.intervalSec}
              onChange={(e) => void saveSettings({ intervalSec: Number(e.target.value) })}
            >
              <option value={1}>每 1 秒一張</option>
              <option value={2}>每 2 秒一張</option>
              <option value={5}>每 5 秒一張</option>
              <option value={15}>每 15 秒一張</option>
            </select>
          </div>
          <div>
            上限
            <select value={data.settings.maxMb} onChange={(e) => void saveSettings({ maxMb: Number(e.target.value) })}>
              {[200, 500, 1000, 2000].map((v) => (
                <option key={v} value={v}>{v} MB</option>
              ))}
            </select>
            <span className="muted">
              已用 {mb(data.usedBytes)}
              {data.first && data.last ? ` · 存了 ${span(data.first, data.last)}` : ""}
            </span>
          </div>
          <span className="muted">
            不會為了錄影多截一次螢幕:平常沿用縮圖每 10 秒的擷取,腳本執行時用它自己的畫面,所以那段會變密。
          </span>
        </div>
      )}

      {!shots.length ? (
        <p className="sp-replay-empty">
          {data && !data.settings.enabled
            ? "回放錄製已關閉"
            : data?.first
              ? "這段時間沒有錄到畫面 — 換一個範圍看看"
              : "還沒有錄到畫面 — 裝置連著就會開始累積"}
        </p>
      ) : (
        <>
          <div className="sp-replay-stage">
            <img src={`/api/devices/${encodeURIComponent(serial)}/replay/${current?.at}`} alt="" />
          </div>

          <div className="sp-replay-track">
            <input
              type="range"
              min={0}
              max={Math.max(0, shots.length - 1)}
              value={at}
              onChange={(e) => {
                setPlaying(false);
                setFollow(false);
                setAt(Number(e.target.value));
              }}
            />
            {ticks.map((left, i) => (
              <span key={i} className="sp-replay-tick" style={{ left: `${left}%` }} />
            ))}
          </div>

          <div className="sp-replay-controls">
            <button onClick={() => { setFollow(false); setPlaying((v) => !v); }} title={playing ? "暫停" : "播放"}>
              <Icon name={playing ? "stop" : "play"} size={13} />
            </button>
            {SPEEDS.map((s) => (
              <button key={s} className={speed === s ? "on" : ""} onClick={() => setSpeed(s)}>
                {SPEED_LABELS[s]}
              </button>
            ))}
            <button className={follow ? "on" : ""} onClick={() => setFollow((v) => !v)} title="跟著最新的畫面">
              最新
            </button>
            <span style={{ flex: 1 }} />
            <span className="muted">
              {at + 1}/{shots.length} · {current ? stamp(current.at) : ""}
            </span>
          </div>

          <div className="sp-replay-caption">
            {caption ? (
              <>
                <span className="sp-replay-script">{caption.scriptName}</span> {caption.message}
              </>
            ) : (
              <span className="muted">這段時間沒有腳本在跑</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
