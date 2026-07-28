import type { DeviceInfo, DeviceSchedule, SessionConnections } from "@speedcrcpy/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { DeviceStatsChips, useDeviceStats } from "../core/device-stats";
import { DeviceThumbnail } from "../core/DeviceThumbnail";
import { useDeviceList } from "../core/events-socket";

const STATE_LABEL: Record<DeviceInfo["state"], string> = {
  device: "已連線",
  offline: "離線",
  unauthorized: "未授權",
  connecting: "連線中",
  disconnected: "已斷線",
};

const STATE_COLOR: Record<DeviceInfo["state"], string> = {
  device: "#3ddc84",
  offline: "#f0a94b",
  unauthorized: "#ff6b6b",
  connecting: "#f0a94b",
  disconnected: "#5a6672",
};

export function DeviceList({ onOpenSession }: { onOpenSession: (serial: string) => void }) {
  const devices = useDeviceList();
  const [error, setError] = useState("");
  const [build, setBuild] = useState<{ version: string; builtAt: string }>();

  // /api/health is unauthenticated — surface the running build (git SHA) so
  // it's clear which version is deployed.
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((d: { version?: string; builtAt?: string }) => setBuild({ version: d.version ?? "", builtAt: d.builtAt ?? "" }))
      .catch(() => {});
  }, []);

  async function action(path: string, body: Record<string, unknown>) {
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      if (e instanceof ApiError && e.code === "unauthorized") {
        setError("裝置拒絕連線:請先在手機上完成配對(無線偵錯 → 配對),或確認已授權此電腦");
      } else if (e instanceof ApiError && e.code === "network") {
        setError("無法連上該位址,確認手機已開啟無線偵錯且 IP:port 正確");
      } else {
        setError(e instanceof Error ? e.message : "操作失敗");
      }
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>speedcrcpy</h1>
        <span className="muted">裝置</span>
        {build?.version && (
          <span
            className="muted"
            style={{ marginLeft: "auto", fontSize: 11, fontFamily: "monospace" }}
            title={build.builtAt ? `build ${build.version}\n${build.builtAt}` : `build ${build.version}`}
          >
            {build.version === "dev" ? "dev" : build.version.slice(0, 7)}
          </span>
        )}
      </header>

      <ConnectForm onConnect={(address) => action("/api/devices/connect", { address })} onPair={(address, code) => action("/api/devices/pair", { address, code })} />
      {error && <p className="error-text">{error}</p>}

      {devices === undefined ? (
        <p className="muted">載入中…</p>
      ) : devices.length === 0 ? (
        <p className="muted">尚無裝置。手機開啟「開發人員選項 → 無線偵錯」後,輸入 IP:port 連線。</p>
      ) : (
        devices.map((device) => (
          <DeviceCard key={device.serial} device={device} onOpenSession={onOpenSession} onAction={action} />
        ))
      )}

      <SchedulePanel />
      <ConnectionsPanel />
    </div>
  );
}

/** All devices' automation scripts: what's running, waiting, and due next. */
function SchedulePanel() {
  const [devices, setDevices] = useState<DeviceSchedule[]>([]);

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      api<DeviceSchedule[]>("/api/schedule").then(setDevices).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => clearInterval(timer);
  }, []);

  const total = devices.reduce((n, d) => n + d.scripts.length, 0);
  if (total === 0) return null;

  const triggerLabel = (s: DeviceSchedule["scripts"][number]) =>
    s.trigger.type === "daily" ? `每日 ${s.trigger.time}` : s.trigger.type === "persistent" ? "常駐" : "手動";

  return (
    <section className="connections">
      <header className="connections-head">
        <span style={{ fontWeight: 600 }}>自動化排程</span>
        <span className="muted">{total}</span>
      </header>
      {devices.map((d) => (
        <div key={d.serial} className="connections-device">
          <div className="connections-device-head">
            <span className="device-sub muted">{d.serial}</span>
            {d.humanActive && <span className="sched-human">手動操作中 · 腳本暫讓</span>}
          </div>
          {d.scripts.map((s) => (
            <div key={s.id} className="connection-row">
              <span className={`sched-dot ${s.state}`} />
              <span>{s.name}</span>
              <span className="muted" style={{ fontSize: 12 }}>{triggerLabel(s)}</span>
              {!s.enabled && <span className="muted" style={{ fontSize: 11 }}>已停用</span>}
              <span style={{ marginLeft: "auto", fontSize: 11 }} className="muted">
                {s.state === "running" ? "執行中" : s.state === "waiting" ? "等待中" : s.nextRunAt ? `下次 ${new Date(s.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
              </span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 時`;
}

/** Live list of viewer connections across all device sessions, with kick. */
function ConnectionsPanel() {
  const [sessions, setSessions] = useState<SessionConnections[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSessions(await api<SessionConnections[]>("/api/sessions"));
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!document.hidden) {
        void refresh();
        setNow(Date.now());
      }
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function kick(body: { viewerId: string } | { serial: string }) {
    setBusy(true);
    try {
      await api("/api/sessions/kick", { method: "POST", body: JSON.stringify(body) });
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  const total = sessions.reduce((n, s) => n + s.viewers.length, 0);
  if (total === 0) return null;

  return (
    <section className="connections">
      <header className="connections-head">
        <span style={{ fontWeight: 600 }}>目前連線</span>
        <span className="muted">{total}</span>
      </header>
      {sessions.map((s) => (
        <div key={s.serial} className="connections-device">
          <div className="connections-device-head">
            <span className="device-name">{s.deviceName}</span>
            <span className="muted device-sub">{s.serial}</span>
            <button className="kick-btn" disabled={busy} onClick={() => void kick({ serial: s.serial })}>
              全部踢掉
            </button>
          </div>
          {s.viewers.map((v) => (
            <div key={v.id} className="connection-row">
              <span className={`transport-badge${v.transport === "webtransport" ? " wt" : ""}`}>
                {v.transport === "webtransport" ? "WT" : "WS"}
              </span>
              <span className="muted" style={{ fontFamily: "monospace", fontSize: 12 }}>{v.address ?? "—"}</span>
              <span className="muted" style={{ fontSize: 12 }}>{fmtAge(now - v.connectedAt)}前</span>
              {v.controlling && <span className="ctrl-badge">控制中</span>}
              <button className="kick-btn" disabled={busy} onClick={() => void kick({ viewerId: v.id })}>
                踢掉
              </button>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function DeviceCard({
  device,
  onOpenSession,
  onAction,
}: {
  device: DeviceInfo;
  onOpenSession: (serial: string) => void;
  onAction: (path: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const address = device.address ?? device.serial;
  const stats = useDeviceStats(device.state === "device" ? device.serial : undefined);
  return (
    <div className="device-card">
      <span className="device-dot" style={{ background: STATE_COLOR[device.state] }} />
      {device.state === "device" && <DeviceThumbnail serial={device.serial} onClick={() => onOpenSession(device.serial)} />}
      <div className="device-main">
        <div className="device-info">
          <div className="device-name">{device.name}</div>
          <div className="muted device-sub">
            {device.serial} · {STATE_LABEL[device.state]}
          </div>
          {stats && (
            <div className="device-stats">
              <DeviceStatsChips stats={stats} />
            </div>
          )}
        </div>
        <div className="device-actions">
          <label className="muted device-autoconnect">
            <input
              type="checkbox"
              checked={device.autoConnect}
              onChange={(e) => onAction("/api/devices/auto-connect", { address, autoConnect: e.target.checked })}
            />
            自動重連
          </label>
          {device.state === "device" ? (
            <>
              <button className="primary" onClick={() => onOpenSession(device.serial)}>
                鏡像
              </button>
              <button onClick={() => onAction("/api/devices/disconnect", { address })}>斷線</button>
            </>
          ) : (
            <button onClick={() => onAction("/api/devices/connect", { address })}>連線</button>
          )}
          <button title="移除此裝置" onClick={() => onAction("/api/devices/forget", { address })}>
            移除
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectForm({
  onConnect,
  onPair,
}: {
  onConnect: (address: string) => void;
  onPair: (address: string, code: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairAddress, setPairAddress] = useState("");
  const [pairCode, setPairCode] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (address.trim()) onConnect(address.trim());
  }

  function submitPair(event: FormEvent) {
    event.preventDefault();
    if (pairAddress.trim() && pairCode.trim()) onPair(pairAddress.trim(), pairCode.trim());
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="裝置位址,如 192.168.1.50:5555"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!address.trim()}>
          連線
        </button>
        <button type="button" onClick={() => setPairing(!pairing)}>
          配對
        </button>
      </form>
      {pairing && (
        <form onSubmit={submitPair} style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            placeholder="配對位址(無線偵錯顯示的 IP:port)"
            value={pairAddress}
            onChange={(e) => setPairAddress(e.target.value)}
          />
          <input style={{ width: 120 }} placeholder="配對碼" value={pairCode} onChange={(e) => setPairCode(e.target.value)} />
          <button type="submit" disabled={!pairAddress.trim() || !pairCode.trim()}>
            送出
          </button>
        </form>
      )}
    </div>
  );
}
