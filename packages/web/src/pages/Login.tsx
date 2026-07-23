import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
      onSuccess();
    } catch (e) {
      if (e instanceof ApiError && e.code === "rate_limited") {
        setError("嘗試次數過多,請一分鐘後再試");
      } else {
        setError("密碼錯誤");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-page">
      <form className="card" onSubmit={submit}>
        <h1 style={{ margin: 0, fontSize: 20 }}>speedcrcpy</h1>
        <p className="muted" style={{ margin: 0 }}>
          遠端操控你的 Android 裝置
        </p>
        <input
          type="password"
          placeholder="密碼"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <p className="error-text">{error}</p>
        <button className="primary" type="submit" disabled={busy || password.length === 0}>
          登入
        </button>
      </form>
    </div>
  );
}
