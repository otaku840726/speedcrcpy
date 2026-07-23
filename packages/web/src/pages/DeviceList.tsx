import type { DeviceInfo } from "@speedcrcpy/shared";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
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
    </div>
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
  return (
    <div className="card" style={{ maxWidth: "none", flexDirection: "row", alignItems: "center", gap: 16, padding: 16 }}>
      <span style={{ width: 10, height: 10, borderRadius: 5, background: STATE_COLOR[device.state], flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{device.name}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {device.serial} · {STATE_LABEL[device.state]}
        </div>
      </div>
      <label className="muted" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
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
