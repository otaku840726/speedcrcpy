import { useEffect, useState } from "react";
import { Icon } from "../core/icons";

/**
 * A still of the device, taken on demand.
 *
 * Captured from the device rather than lifted off the mirror: the mirror is a
 * compressed stream at whatever quality the link is coping with, which is fine
 * to watch and poor to keep. This is the same full-resolution `screencap` the
 * template picker uses, so what you save is what the device actually showed.
 */
export function Screenshot({ serial, name, onClose }: { serial: string; name: string; onClose: () => void }) {
  const [shot, setShot] = useState<{ url: string; blob: Blob; width: number; height: number }>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    fetch(`/api/devices/${encodeURIComponent(serial)}/screenshot`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("擷取畫面失敗"))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => !cancelled && setShot({ url: url!, blob, width: img.naturalWidth, height: img.naturalHeight });
        img.src = url;
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "擷取畫面失敗"));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [serial]);

  /**
   * Writing an image to the clipboard needs a secure context, so on a plain
   * http LAN address the browser refuses. Better to say so on a disabled
   * button than to offer one that quietly does nothing.
   */
  const canCopy = typeof ClipboardItem !== "undefined" && !!navigator.clipboard?.write && window.isSecureContext;

  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `${name || serial}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;

  return (
    <div className="script-panel sp-shot">
      <div className="sp-head">
        <Icon name="camera" size={18} />
        <span style={{ fontWeight: 600 }}>截圖</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} title="關閉">✕</button>
      </div>

      {error && <p className="error-text">{error}</p>}
      {!shot && !error && <p className="sp-replay-empty">擷取中…</p>}

      {shot && (
        <div className="sp-shot-body">
          <img src={shot.url} alt="" />
          <div className="sp-shot-side">
            <span className="muted">
              {shot.width} × {shot.height} · {Math.round(shot.blob.size / 1024)} KB
            </span>
            <button
              className={copied ? "saved" : "primary"}
              disabled={!canCopy}
              title={canCopy ? "複製到剪貼簿" : "這個連線不是 HTTPS,瀏覽器不允許寫入剪貼簿"}
              onClick={() => {
                void navigator.clipboard
                  .write([new ClipboardItem({ "image/png": shot.blob })])
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : "複製失敗"));
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "已複製" : "複製到剪貼簿"}
            </button>
            {!canCopy && <span className="sp-warn-inline">非 HTTPS 連線無法寫入剪貼簿 — 請用下載</span>}
            <a className="sp-shot-download" href={shot.url} download={filename}>
              <Icon name="download" size={13} /> 下載 PNG
            </a>
            <span className="muted sp-shot-name">{filename}</span>
          </div>
        </div>
      )}
    </div>
  );
}
