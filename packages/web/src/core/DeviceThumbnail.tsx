import { useEffect, useRef, useState } from "react";

const THUMB_REFRESH_MS = 5000;

/**
 * Live screen preview for a connected device. Double-buffered: each refresh
 * preloads the new capture off-screen and only swaps it in once loaded, so the
 * previous frame stays visible during the ~1-2 s capture (no flicker/blank).
 * Refresh pauses while the tab is hidden.
 */
export function DeviceThumbnail({
  serial,
  onClick,
  className = "device-thumb",
  title = "點擊鏡像",
}: {
  serial: string;
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  const [shown, setShown] = useState<string | undefined>();
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setShown(undefined);
    readyRef.current = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      const url = `/api/devices/${encodeURIComponent(serial)}/thumbnail?t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        if (!cancelled) {
          setShown(url);
          readyRef.current = true;
        }
      };
      img.src = url;
    };
    load();
    const id = window.setInterval(load, THUMB_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [serial]);

  return (
    <div className={className} onClick={onClick} title={title}>
      {shown ? <img src={shown} alt="" /> : <span className="device-thumb-placeholder">…</span>}
    </div>
  );
}
