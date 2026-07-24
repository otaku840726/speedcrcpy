import {
  BITRATE_OPTIONS,
  DEFAULT_QUALITY,
  FPS_OPTIONS,
  qualityLabel,
  RESOLUTION_OPTIONS,
  sameQuality,
  type ClientMessage,
  type QualitySettings,
  type ServerMessage,
  type VideoMeta,
} from "@speedcrcpy/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioPipeline, type AudioState } from "../core/audio-pipeline";
import { useDeviceList } from "../core/events-socket";
import { attachInput } from "../core/input";
import { SessionClient } from "../core/session-client";
import { VideoPipeline } from "../core/video-pipeline";
import { DeviceRail } from "./DeviceRail";

const isWideScreen = () => (typeof window !== "undefined" ? window.innerWidth >= 700 : true);

interface SessionState {
  status: "connecting" | "streaming" | "reconnecting" | "gone" | "error";
  deviceName: string;
  detail?: string;
}

const IS_COARSE_POINTER = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** Ladder rung (720p / 2 Mbps / 30) a software decoder caps auto-adaptation at. */
const SOFTWARE_MAX_LADDER_INDEX = 3;

/** Copy that also works outside secure contexts (plain-HTTP LAN access). */
function copyTextFallback(text: string): void {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function Session({
  serial,
  onBack,
  onSwitch,
}: {
  serial: string;
  onBack: () => void;
  onSwitch: (serial: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imeRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<SessionClient | undefined>(undefined);
  const audioRef = useRef<AudioPipeline | undefined>(undefined);
  const [state, setState] = useState<SessionState>({ status: "connecting", deviceName: serial });
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | undefined>();
  const [audioState, setAudioState] = useState<AudioState | undefined>();
  const [clipboardToast, setClipboardToast] = useState<string | undefined>();
  const [wide, setWide] = useState(isWideScreen);
  const [railOpen, setRailOpen] = useState(false);

  const allDevices = useDeviceList();
  const connected = (allDevices ?? []).filter((d) => d.state === "device");
  const multiDevice = connected.length > 1;
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteOpenRef = useRef(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);
  const [auto, setAuto] = useState(true);
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY);
  const [stats, setStats] = useState<Extract<ServerMessage, { type: "stats" }> | undefined>();
  const [showStats, setShowStats] = useState(false);
  const [controlling, setControlling] = useState(true);
  const [screenOff, setScreenOff] = useState(false);

  const send = useCallback((message: ClientMessage) => {
    clientRef.current?.send(message);
  }, []);

  // Apply a quality choice optimistically (server confirms via qualityChanged).
  const applyQuality = useCallback(
    (nextQuality: QualitySettings, nextAuto: boolean) => {
      setAuto(nextAuto);
      setQuality(nextQuality);
      send({ type: "setQuality", auto: nextAuto, quality: nextQuality });
    },
    [send],
  );

  // Switch to the device `step` positions away (wraps around).
  const switchBy = useCallback(
    (step: number) => {
      if (connected.length < 2) return;
      const idx = connected.findIndex((d) => d.serial === serial);
      const from = idx < 0 ? 0 : idx;
      const next = connected[(from + step + connected.length) % connected.length];
      if (next && next.serial !== serial) onSwitch(next.serial);
    },
    [connected, serial, onSwitch],
  );

  // Track wide vs narrow layout via window resize (matchMedia change events
  // don't fire reliably on programmatic resize), and close the mobile rail
  // when crossing the breakpoint.
  useEffect(() => {
    const onResize = () => {
      const isWide = window.innerWidth >= 700;
      setWide(isWide);
      if (isWide) setRailOpen(false);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Alt+digit jumps to the Nth device; Alt+←/→ cycles. Alt keeps these clear
  // of the physical-keyboard text that gets injected into the device.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key >= "1" && e.key <= "9") {
        const target = connected[Number(e.key) - 1];
        if (target && target.serial !== serial) {
          onSwitch(target.serial);
          e.preventDefault();
        }
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        switchBy(1);
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        switchBy(-1);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected, serial, onSwitch, switchBy]);

  const openPasteDialog = useCallback(() => {
    pasteOpenRef.current = true;
    setPasteOpen(true);
  }, []);

  const closePasteDialog = useCallback(() => {
    pasteOpenRef.current = false;
    setPasteOpen(false);
  }, []);

  /** Silent clipboard read needs a secure context; otherwise (or when the
   * read is denied/empty) fall back to a manual paste panel. */
  const pasteToDevice = useCallback(() => {
    if (navigator.clipboard?.readText) {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text) send({ type: "clipboardSet", content: text, paste: true });
          else openPasteDialog();
        })
        .catch(() => openPasteDialog());
    } else {
      openPasteDialog();
    }
  }, [send, openPasteDialog]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pipeline = new VideoPipeline();
    pipeline.element.className = "session-canvas";
    container.appendChild(pipeline.element);
    pipeline.onSizeChanged = (width, height) => setVideoSize({ width, height });
    let started = false;
    let lastMeta: VideoMeta | undefined;
    let forceRestart = false;

    const audio = new AudioPipeline();
    audioRef.current = audio;
    audio.onStateChange = setAudioState;

    const client = new SessionClient(serial, {
      onServerMessage(message: ServerMessage) {
        switch (message.type) {
          case "hello":
            setState((s) => ({ ...s, deviceName: message.deviceName }));
            setAuto(message.auto);
            setQuality(message.quality);
            setControlling(message.controlling);
            setScreenOff(message.screenOff);
            break;
          case "controlChanged":
            setControlling(message.controlling);
            break;
          case "screenOffChanged":
            setScreenOff(message.off);
            break;
          case "qualityChanged":
            setAuto(message.auto);
            setQuality(message.quality);
            break;
          case "ping":
            client.send({
              type: "pong",
              pingId: message.pingId,
              serverSentAt: message.sentAt,
              clientReceivedAt: Date.now(),
            });
            break;
          case "stats":
            setStats(message);
            break;
          case "clipboard":
            // navigator.clipboard is undefined outside secure contexts
            // (plain-HTTP LAN access) — fall back to the tap-to-copy toast.
            if (navigator.clipboard) {
              void navigator.clipboard
                .writeText(message.content)
                .then(() => {
                  setClipboardToast(undefined);
                })
                .catch(() => {
                  // No permission (or iOS): offer a tap-to-copy fallback.
                  setClipboardToast(message.content);
                });
            } else {
              setClipboardToast(message.content);
            }
            break;
          case "deviceGone":
            setState((s) => ({ ...s, status: "gone" }));
            break;
          case "error":
            setState((s) => ({ ...s, status: "error", detail: message.message }));
            break;
        }
      },
      onConnected() {
        // A reconnect is a fresh stream generation — the next META must
        // restart the decoder even if its parameters look identical.
        forceRestart = true;
        setState((s) => (s.status === "streaming" ? s : { ...s, status: "connecting" }));
      },
      onDisconnected() {
        setState((s) => ({ ...s, status: "reconnecting" }));
      },
      onVideoMeta(meta: VideoMeta) {
        // Restarting the decoder blanks the picture for a moment — only do
        // it when the stream generation actually changed (codec, quality
        // preset, reconnect). Dimensions are informational: decoders follow
        // the in-stream SPS on their own, so rotation and repeated METAs
        // around RESET_VIDEO must not flicker the screen.
        const unchanged =
          !forceRestart &&
          started &&
          lastMeta &&
          lastMeta.codec === meta.codec &&
          sameQuality(lastMeta.quality, meta.quality);
        lastMeta = meta;
        if (!unchanged) {
          pipeline.start(meta);
          forceRestart = false;
          // Software decode can't keep up with high rungs — a pushed-too-far
          // decoder janks the main thread, which the server misreads as
          // network congestion. Cap auto-adaptation at the 720p/2M/30 rung.
          if (pipeline.isSoftware) {
            client.send({ type: "viewerCaps", maxLadderIndex: SOFTWARE_MAX_LADDER_INDEX });
          }
        }
        started = true;
        setState((s) => (s.status === "connecting" ? { ...s, status: "streaming" } : s));
        setVideoSize({ width: meta.width, height: meta.height });
      },
      onVideoConfig(config) {
        pipeline.setConfig(config);
      },
      onVideoFrame(frame) {
        if (started) pipeline.pushFrame(frame);
      },
      onAudioMeta(meta) {
        if (AudioPipeline.isSupported) {
          void audio.start(meta);
        } else {
          setAudioState("unavailable");
        }
      },
      onAudioData(pts, data) {
        audio.push(pts, data);
      },
    });
    clientRef.current = client;

    pipeline.onDecoderError = (detail) => {
      client.send({ type: "decoderError", detail });
    };

    const detachInput = attachInput(pipeline.element, { send: (m) => client.send(m) });

    // Push the local clipboard to the device when the viewer regains focus,
    // so device-side paste has fresh content. Silently skipped if denied.
    let lastSyncedClipboard = "";
    const syncClipboard = () => {
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text && text !== lastSyncedClipboard) {
            lastSyncedClipboard = text;
            client.send({ type: "clipboardSet", content: text, paste: false });
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", syncClipboard);

    // Keep the screen awake while mirroring; reacquire when returning to the tab.
    let wakeLock: WakeLockSentinel | undefined;
    const acquireWakeLock = () => {
      navigator.wakeLock
        ?.request("screen")
        .then((sentinel) => (wakeLock = sentinel))
        .catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquireWakeLock();
    };
    acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibility);

    // Desktop: focus the hidden IME input when the user clicks the video, so
    // physical-keyboard text goes to the device. Do NOT steal focus back on
    // blur — that fights native controls (the quality dropdown would reopen
    // and immediately close). Mobile viewers use the on-screen keyboard button.
    const ime = imeRef.current;
    const focusIme = () => {
      if (!IS_COARSE_POINTER && !pasteOpenRef.current) ime?.focus();
    };
    if (!IS_COARSE_POINTER) {
      focusIme();
      pipeline.element.addEventListener("pointerdown", focusIme);
    }

    return () => {
      detachInput();
      document.removeEventListener("visibilitychange", onVisibility);
      void wakeLock?.release().catch(() => {});
      window.removeEventListener("focus", syncClipboard);
      pipeline.element.removeEventListener("pointerdown", focusIme);
      client.close();
      audio.dispose();
      audioRef.current = undefined;
      pipeline.dispose();
      pipeline.element.remove();
      clientRef.current = undefined;
    };
  }, [serial]);

  return (
    <div className="session-page">
      <div className="session-body">
        {wide && multiDevice && (
          <DeviceRail devices={connected} currentSerial={serial} onSwitch={onSwitch} mode="persistent" />
        )}
        <div className="session-main">
          <div className="session-topbar">
            <button onClick={onBack}>← 返回</button>
            {multiDevice && (
              <button className="topbar-arrow" title="上一台 (Alt+←)" onClick={() => switchBy(-1)}>
                ‹
              </button>
            )}
            <span style={{ fontWeight: 600 }}>{state.deviceName}</span>
            {multiDevice && (
              <button className="topbar-arrow" title="下一台 (Alt+→)" onClick={() => switchBy(1)}>
                ›
              </button>
            )}
            <span className="muted" style={{ fontSize: 12 }}>
              {videoSize ? `${videoSize.width}×${videoSize.height}` : ""}
            </span>
        <QualityControl auto={auto} quality={quality} onApply={applyQuality} />
        <span style={{ flex: 1 }} />
        <button
          title={screenOff ? "手機螢幕已關閉(點擊點亮)" : "關閉手機實體螢幕以降溫"}
          onClick={() => send({ type: "setScreenOff", off: !screenOff })}
          style={screenOff ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
        >
          {screenOff ? "🌙" : "☀"}
        </button>
        <button title="統計" onClick={() => setShowStats((v) => !v)}>
          📊
        </button>
        {audioState === "locked" && (
          <button title="點擊開啟聲音" onClick={() => void audioRef.current?.unlock()}>
            🔇
          </button>
        )}
        {audioState === "unavailable" && (
          <span className="muted" title="此瀏覽器不支援音訊解碼(iOS 需 Safari 26+)">
            🔇
          </span>
        )}
        {state.status === "connecting" && <span className="muted">連線中…</span>}
        {state.status === "reconnecting" && <span style={{ color: "#f0a94b", fontSize: 13 }}>重新連線中…</span>}
        {state.status === "gone" && <span className="error-text">裝置離線,等待重連…</span>}
        {state.status === "error" && <span className="error-text">{state.detail ?? "錯誤"}</span>}
      </div>
      <div ref={containerRef} className="session-stage">
        {!wide && multiDevice && (
          <div className="rail-handle" title="切換裝置" onClick={() => setRailOpen(true)} />
        )}
        {!wide && (
          <DeviceRail
            devices={connected}
            currentSerial={serial}
            onSwitch={onSwitch}
            mode="overlay"
            open={railOpen}
            onClose={() => setRailOpen(false)}
          />
        )}
        {showStats && stats && (
          <div className="stats-overlay">
            <div>
              {auto ? "自動" : "手動"} {qualityLabel(stats.quality)} · 模式{" "}
              {stats.mode === "through" ? "穿透" : "閘控"} · {stats.congestion}
            </div>
            <div>
              編碼 {(stats.encodeBitrate / 1_000_000).toFixed(1)} Mbps · 實送 {(stats.sendBitrate / 1_000_000).toFixed(2)} Mbps
            </div>
            <div>
              RTT {stats.rttMs} ms · 延遲梯度 {stats.delayGradientMs} ms · 丟幀 {stats.droppedFrames}
            </div>
          </div>
        )}
        {!controlling && (
          <button className="clipboard-toast" style={{ top: 16, bottom: "auto" }} onClick={() => send({ type: "takeControl" })}>
            檢視模式 — 點擊取得控制權
          </button>
        )}
        {clipboardToast !== undefined && (
          <button
            className="clipboard-toast"
            onClick={() => {
              copyTextFallback(clipboardToast);
              setClipboardToast(undefined);
            }}
          >
            手機複製了文字 — 點擊複製到本機
          </button>
        )}
        {pasteOpen && (
          <div className="paste-dialog">
            <textarea ref={pasteInputRef} autoFocus rows={3} placeholder="在此貼上文字(長按 → 貼上)…" />
            <div className="paste-dialog-actions">
              <button onClick={closePasteDialog}>取消</button>
              <button
                className="primary"
                onClick={() => {
                  const text = pasteInputRef.current?.value ?? "";
                  if (text) send({ type: "clipboardSet", content: text, paste: true });
                  closePasteDialog();
                }}
              >
                貼到手機
              </button>
            </div>
          </div>
        )}
      </div>
          <ImeInput inputRef={imeRef} send={send} />
          <NavBar send={send} onShowKeyboard={() => imeRef.current?.focus()} onPaste={pasteToDevice} />
        </div>
      </div>
    </div>
  );
}

/**
 * Quality control: a summary button that opens a popover with an auto-adapt
 * toggle and three independent dropdowns (resolution / bitrate / fps). The
 * dropdowns are disabled while auto is on — the congestion controller drives
 * them — and editing any one drops into manual mode.
 */
function QualityControl({
  auto,
  quality,
  onApply,
}: {
  auto: boolean;
  quality: QualitySettings;
  onApply: (quality: QualitySettings, auto: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close when clicking anywhere outside the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="quality-pop" ref={wrapRef}>
      <button className="quality-select" title="畫質設定" onClick={() => setOpen((v) => !v)}>
        {auto ? "🅰︎ 自動" : "✋ 手動"} · {qualityLabel(quality)}
      </button>
      {open && (
        <div className="quality-panel">
          <label className="quality-row quality-auto">
            <span>自動調適</span>
            <input type="checkbox" checked={auto} onChange={(e) => onApply(quality, e.target.checked)} />
          </label>
          <label className="quality-row">
            <span>解析度</span>
            <select
              value={quality.maxSize}
              disabled={auto}
              onChange={(e) => onApply({ ...quality, maxSize: Number(e.target.value) }, false)}
            >
              {RESOLUTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="quality-row">
            <span>位元率</span>
            <select
              value={quality.videoBitRate}
              disabled={auto}
              onChange={(e) => onApply({ ...quality, videoBitRate: Number(e.target.value) }, false)}
            >
              {BITRATE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="quality-row">
            <span>FPS</span>
            <select
              value={quality.maxFps}
              disabled={auto}
              onChange={(e) => onApply({ ...quality, maxFps: Number(e.target.value) }, false)}
            >
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

function NavBar({
  send,
  onShowKeyboard,
  onPaste,
}: {
  send: (m: ClientMessage) => void;
  onShowKeyboard: () => void;
  onPaste: () => void;
}) {
  return (
    <div className="session-navbar">
      <button title="音量-" onClick={() => send({ type: "navigate", key: "volumeDown" })}>
        🔉
      </button>
      <button title="音量+" onClick={() => send({ type: "navigate", key: "volumeUp" })}>
        🔊
      </button>
      <button title="電源" onClick={() => send({ type: "navigate", key: "power" })}>
        ⏻
      </button>
      <button title="把本機剪貼簿貼到手機" onClick={onPaste}>
        📋
      </button>
      <span style={{ flex: 1 }} />
      <button title="返回" onClick={() => send({ type: "navigate", key: "back" })}>
        ◀
      </button>
      <button title="主畫面" onClick={() => send({ type: "navigate", key: "home" })}>
        ●
      </button>
      <button title="多工" onClick={() => send({ type: "navigate", key: "appSwitch" })}>
        ■
      </button>
      <span style={{ flex: 1 }} />
      <button title="旋轉" onClick={() => send({ type: "rotate" })}>
        ⟳
      </button>
      {IS_COARSE_POINTER && (
        <button title="鍵盤" onClick={onShowKeyboard}>
          ⌨
        </button>
      )}
    </div>
  );
}

/**
 * Hidden input that receives IME composition (the only reliable path for CJK
 * and mobile virtual keyboards) and forwards committed text to the device.
 *
 * Virtual-keyboard quirks this handles:
 * - Mobile IMEs need an ON-SCREEN input to anchor composition (CSS keeps it
 *   inside the viewport, just visually imperceptible).
 * - Android soft keyboards report Backspace as "Unidentified"/keyCode 229 —
 *   undetectable via keydown. A zero-width-space sentinel lives in the input;
 *   when an input event shows the sentinel got deleted, that WAS a Backspace.
 */
const IME_SENTINEL = "\u200B";
const ANDROID_DEL = 67;

function ImeInput({
  inputRef,
  send,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  send: (m: ClientMessage) => void;
}) {
  const composing = useRef(false);

  const reset = (input: HTMLInputElement) => {
    input.value = IME_SENTINEL;
    input.setSelectionRange(input.value.length, input.value.length);
  };

  return (
    <input
      ref={inputRef}
      className="ime-input"
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      spellCheck={false}
      onFocus={(e) => reset(e.currentTarget)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={(e) => {
        composing.current = false;
        const input = e.currentTarget;
        const text = input.value.split(IME_SENTINEL).join("");
        if (text) send({ type: "text", text });
        reset(input);
      }}
      onInput={(e) => {
        if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
        const input = e.currentTarget;
        const value = input.value;
        if (!value.includes(IME_SENTINEL)) {
          // Sentinel deleted → soft-keyboard Backspace.
          send({ type: "key", action: "down", keycode: ANDROID_DEL, metaState: 0, repeat: 0 });
          send({ type: "key", action: "up", keycode: ANDROID_DEL, metaState: 0, repeat: 0 });
        }
        const text = value.split(IME_SENTINEL).join("");
        if (text) send({ type: "text", text });
        reset(input);
      }}
    />
  );
}
