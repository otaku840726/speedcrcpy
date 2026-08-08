import type { ScriptAppAction } from "@speedcrcpy/shared";
import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../core/icons";

type AppStep = { type: "app"; action: ScriptAppAction; package: string; waitMs?: number };

const ACTIONS: { value: ScriptAppAction; label: string }[] = [
  { value: "restart", label: "重啟" },
  { value: "start", label: "啟動" },
  { value: "stop", label: "關閉" },
];

/**
 * The device's installed apps, fetched once per device rather than once per
 * step: `pm list packages` is a shell round trip, and a script that restarts an
 * app on three different branches would otherwise make three of them every time
 * the panel renders.
 */
const cache = new Map<string, Promise<{ packages: string[]; foreground?: string }>>();
const apps = (serial: string) => {
  let pending = cache.get(serial);
  if (!pending) {
    pending = api<{ packages: string[]; foreground?: string }>(`/api/devices/${encodeURIComponent(serial)}/apps`);
    // A failed read should not be remembered as the answer — the device may
    // just have been asleep.
    pending.catch(() => cache.delete(serial));
    cache.set(serial, pending);
  }
  return pending;
};

/**
 * Start, stop, or restart an app.
 *
 * The package is chosen, not typed: a name like `com.square_enix.android_googleplay.FFBEWW`
 * is not something anyone recalls correctly, and getting it wrong produces a
 * step that silently does nothing. The list is what the device has installed,
 * and the button beside it asks the device what is on screen right now — open
 * the game, press it, done.
 */
export function AppStepBody({
  step,
  serial,
  onChange,
}: {
  step: AppStep;
  serial: string;
  onChange: (patch: Partial<AppStep>) => void;
}) {
  const [list, setList] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    apps(serial)
      .then((got) => alive && setList(got.packages))
      .catch(() => alive && setError("讀不到已安裝的 App"));
    return () => {
      alive = false;
    };
  }, [serial]);

  /** Ask the device now rather than using the cached answer: the whole point is
   * that you just switched to the app you want. */
  const useForeground = () => {
    setBusy(true);
    setError(undefined);
    cache.delete(serial);
    apps(serial)
      .then((got) => {
        setList(got.packages);
        if (got.foreground) onChange({ package: got.foreground });
        else setError("看不出目前是哪個 App");
      })
      .catch(() => setError("讀不到目前的 App"))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <select value={step.action} onChange={(e) => onChange({ action: e.target.value as ScriptAppAction })}>
        {ACTIONS.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
      <select
        className="sp-package"
        value={list?.includes(step.package) ? step.package : ""}
        onChange={(e) => e.target.value && onChange({ package: e.target.value })}
      >
        <option value="">{list ? "— 選 App —" : "讀取中…"}</option>
        {/* A script may name an app that has since been uninstalled, or one
            picked on another device. Keep it selectable rather than silently
            dropping it out of the list. */}
        {step.package && !list?.includes(step.package) && <option value={step.package}>{step.package}</option>}
        {list?.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      <button onClick={useForeground} disabled={busy} title="填入目前畫面上的 App">
        <Icon name="crosshair" size={13} /> {busy ? "讀取中…" : "用目前的"}
      </button>
      {step.action !== "stop" && (
        <>
          等它回到前景
          <input
            className="sp-num"
            value={step.waitMs ?? 0}
            onChange={(e) => onChange({ waitMs: Number(e.target.value) || 0 })}
          />
          ms
        </>
      )}
      {!step.package && <span className="sp-warn-inline">尚未選擇 App</span>}
      {error && <span className="sp-warn-inline">{error}</span>}
    </>
  );
}
