import {
  BITRATE_OPTIONS,
  DEFAULT_QUALITY,
  FPS_OPTIONS,
  qualityLabel,
  RESOLUTION_OPTIONS,
  sameQuality,
  type ClientMessage,
  type DisplayInfo,
  type QualitySettings,
  type ServerMessage,
  type VideoCodec,
  type VideoMeta,
} from "@speedcrcpy/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { AudioPipeline, type AudioState } from "../core/audio-pipeline";
import { DeviceStatsChips, useDeviceStats } from "../core/device-stats";
import { useDeviceList } from "../core/events-socket";
import { Icon } from "../core/icons";
import { attachInput } from "../core/input";
import { SessionClient, type TransportKind } from "../core/session-client";
import { VideoPipeline } from "../core/video-pipeline";
import { DeviceRail } from "./DeviceRail";
import { ScriptPanel } from "./ScriptPanel";

const isWideScreen = () => (typeof window !== "undefined" ? window.innerWidth >= 700 : true);

interface SessionState {
  status: "connecting" | "streaming" | "reconnecting" | "gone" | "error" | "kicked";
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

  const [showDeviceStats, setShowDeviceStats] = useState(true);
  const deviceStats = useDeviceStats(showDeviceStats ? serial : undefined);
  const allDevices = useDeviceList();
  const connected = (allDevices ?? []).filter((d) => d.state === "device");
  const multiDevice = connected.length > 1;
  const [pasteOpen, setPasteOpen] = useState(false);
  const pasteOpenRef = useRef(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);
  const [auto, setAuto] = useState(true);
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY);
  const [codec, setCodec] = useState<VideoCodec>("h264");
  const [stats, setStats] = useState<Extract<ServerMessage, { type: "stats" }> | undefined>();
  const [showStats, setShowStats] = useState(false);
  const [controlling, setControlling] = useState(true);
  const [screenOff, setScreenOff] = useState(false);
  const [transport, setTransport] = useState<TransportKind | undefined>();
  const [scriptsOpen, setScriptsOpen] = useState(false);
  /** Unsaved script edits waiting somewhere. With the panel shut there is
   * nothing else on screen to say so, and the whole point of keeping a draft is
   * that you can leave and come back. */
  const [hasDrafts, setHasDrafts] = useState(false);
  useEffect(() => {
    // Only while the panel is shut: with it open, the panel itself is the
    // authority and polling behind it would just fight its own writes.
    if (scriptsOpen) return;
    void api<{ key: string }[]>("/api/drafts")
      .then((list) => setHasDrafts(list.length > 0))
      .catch(() => {});
  }, [scriptsOpen]);
  const [controlHint, setControlHint] = useState(false);
  const hintTimerRef = useRef<number | undefined>(undefined);
  // Sound is muted by default every session; a user tap unmutes (which also
  // satisfies the browser's autoplay gesture). mutedRef gates the audio feed
  // from inside the (memoized) event handlers.
  const [muted, setMuted] = useState(true);
  const mutedRef = useRef(true);

  const send = useCallback((message: ClientMessage) => {
    clientRef.current?.send(message);
  }, []);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (!next) void audioRef.current?.unlock();
  }, []);

  // View-mode tap on the video: flash a brief "take control" hint, then fade.
  const showControlHint = useCallback(() => {
    setControlHint(true);
    if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current);
    hintTimerRef.current = window.setTimeout(() => setControlHint(false), 2000);
  }, []);
  useEffect(() => () => window.clearTimeout(hintTimerRef.current), []);
  // Every device (re)opened starts muted — "default muted" applies per session.
  useEffect(() => {
    setMuted(true);
    mutedRef.current = true;
  }, [serial]);

  // Apply a quality choice optimistically (server confirms via qualityChanged).
  const applyQuality = useCallback(
    (nextQuality: QualitySettings, nextAuto: boolean) => {
      setAuto(nextAuto);
      setQuality(nextQuality);
      send({ type: "setQuality", auto: nextAuto, quality: nextQuality });
    },
    [send],
  );

  // Live codec switch (server restarts the encoder make-before-break).
  const applyCodec = useCallback(
    (next: VideoCodec) => {
      setCodec(next);
      send({ type: "setCodec", codec: next });
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
            setCodec(message.codec);
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
          case "kicked":
            // Server evicted us — stop reconnecting and say so.
            setState((s) => ({ ...s, status: "kicked" }));
            client.close();
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
      onTransport(kind: TransportKind) {
        setTransport(kind);
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
        setCodec(meta.codec);
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
        if (!mutedRef.current) audio.push(pts, data);
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
            <div className="topbar-line">
              <button className="topbar-back" onClick={onBack} title="返回" aria-label="返回">
                <Icon name="back" />
              </button>
              {multiDevice && (
                <button className="topbar-arrow" title="上一台 (Alt+←)" onClick={() => switchBy(-1)}>
                  ‹
                </button>
              )}
              <span className="topbar-name">{state.deviceName}</span>
              {multiDevice && (
                <button className="topbar-arrow" title="下一台 (Alt+→)" onClick={() => switchBy(1)}>
                  ›
                </button>
              )}
              {transport && (
                <span
                  className={`transport-badge${transport === "webtransport" ? " wt" : ""}`}
                  title={transport === "webtransport" ? "WebTransport (HTTP/3 / QUIC)" : "WebSocket (TCP)"}
                >
                  {transport === "webtransport" ? "WT" : "WS"}
                </span>
              )}
              {state.status === "connecting" && <span className="muted" style={{ fontSize: 13 }}>連線中…</span>}
              {state.status === "reconnecting" && <span style={{ color: "#f0a94b", fontSize: 13 }}>重新連線中…</span>}
              {state.status === "gone" && <span className="error-text">裝置離線,等待重連…</span>}
              {state.status === "kicked" && <span className="error-text">此連線已被中斷</span>}
              {state.status === "error" && <span className="error-text">{state.detail ?? "錯誤"}</span>}
              <span style={{ flex: 1 }} />
              <button
                className={`mode-btn ${controlling ? "controlling" : "viewing"}`}
                title={controlling ? "你正在控制此裝置" : "目前為檢視模式 — 點擊取得控制權"}
                onClick={() => {
                  if (!controlling) send({ type: "takeControl" });
                }}
              >
                {controlling ? "控制中" : "取得控制"}
              </button>
            </div>
            <div className="topbar-line">
              <QualityControl serial={serial} auto={auto} quality={quality} codec={codec} onApply={applyQuality} onSetCodec={applyCodec} />
              <span style={{ flex: 1 }} />
              <div className="topbar-tools">
                <button
                  className={`mute-btn${muted ? " muted" : ""}`}
                  title={
                    audioState === "unavailable"
                      ? "此瀏覽器不支援音訊(iOS 需 Safari 26+)"
                      : muted
                        ? "聲音已靜音 — 點擊開啟"
                        : "點擊靜音"
                  }
                  disabled={audioState === "unavailable"}
                  onClick={toggleMute}
                >
                  <Icon name={muted ? "volumeMute" : "volumeUp"} />
                </button>
                <button
                  title={screenOff ? "手機螢幕已關閉(點擊點亮)" : "關閉手機實體螢幕以降溫"}
                  onClick={() => send({ type: "setScreenOff", off: !screenOff })}
                  style={screenOff ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                >
                  <Icon name={screenOff ? "moon" : "brightness"} />
                </button>
                <button title="連線效能(位元率/RTT/壅塞)" onClick={() => setShowStats((v) => !v)}>
                  <Icon name="reception" />
                </button>
                <button
                  title={showDeviceStats ? "隱藏裝置狀態" : "顯示裝置狀態(電量/溫度/CPU/GPU/RAM)"}
                  onClick={() => setShowDeviceStats((v) => !v)}
                >
                  <Icon name="motherboard" />
                </button>
                <button
                  className={!scriptsOpen && hasDrafts ? "has-draft" : undefined}
                  title={hasDrafts ? "自動化腳本(有未儲存的編輯)" : "自動化腳本"}
                  onClick={() => setScriptsOpen((v) => !v)}
                  style={scriptsOpen ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                >
                  <Icon name="robot" />
                </button>
              </div>
            </div>
          </div>
      <div ref={containerRef} className="session-stage">
        {deviceStats && (
          <div className="device-stats-overlay">
            <DeviceStatsChips stats={deviceStats} />
          </div>
        )}
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
          <>
            {/* Transparent catcher: taps on the video (ignored server-side in
                view mode) flash the hint instead of silently doing nothing. */}
            <div className="view-catch" onClick={showControlHint} />
            {controlHint && (
              <button className="control-hint" onClick={() => send({ type: "takeControl" })}>
                檢視模式 — 點擊取得控制權
              </button>
            )}
          </>
        )}
        {scriptsOpen && <ScriptPanel serial={serial} onClose={() => setScriptsOpen(false)} />}
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
  serial,
  auto,
  quality,
  codec,
  onApply,
  onSetCodec,
}: {
  serial: string;
  auto: boolean;
  quality: QualitySettings;
  codec: VideoCodec;
  onApply: (quality: QualitySettings, auto: boolean) => void;
  onSetCodec: (codec: VideoCodec) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hevcOk, setHevcOk] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Only offer H.265 if this browser can actually decode HEVC (WebCodecs,
  // hardware-dependent) — otherwise selecting it would blank the picture.
  useEffect(() => {
    let cancelled = false;
    const VD = (globalThis as { VideoDecoder?: { isConfigSupported(c: { codec: string }): Promise<{ supported?: boolean }> } })
      .VideoDecoder;
    if (!VD) {
      setHevcOk(false);
      return;
    }
    void VD.isConfigSupported({ codec: "hev1.1.6.L93.B0" })
      .then((r) => !cancelled && setHevcOk(r.supported === true))
      .catch(() => !cancelled && setHevcOk(false));
    return () => {
      cancelled = true;
    };
  }, []);

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
      <button className="quality-select" title={`畫質設定 · ${qualityLabel(quality)}`} onClick={() => setOpen((v) => !v)}>
        {auto ? "自動" : "手動"} ·{" "}
        {RESOLUTION_OPTIONS.find((r) => r.value === quality.maxSize)?.label ?? `${quality.maxSize}px`} · {quality.maxFps}fps
      </button>
      {open && (
        <div className="quality-panel">
          <label className="quality-row quality-auto">
            <span>自動調適</span>
            <input type="checkbox" checked={auto} onChange={(e) => onApply(quality, e.target.checked)} />
          </label>
          <label className="quality-row">
            <span>編碼</span>
            <select value={codec} onChange={(e) => onSetCodec(e.target.value as VideoCodec)}>
              <option value="h264">H.264</option>
              <option value="h265" disabled={!hevcOk}>
                {hevcOk ? "H.265 (省頻寬)" : "H.265 (本機不支援)"}
              </option>
            </select>
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
          <DisplaySection serial={serial} />
        </div>
      )}
    </div>
  );
}

/** Per-device screen-resolution override (wm size / wm density). Reshapes an
 * unusually tall phone so the mirror has smaller letterbox bars. */
function DisplaySection({ serial }: { serial: string }) {
  const [info, setInfo] = useState<DisplayInfo>();
  const [draft, setDraft] = useState<{ width: number; height: number; density: number }>();
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<DisplayInfo>(`/api/devices/${encodeURIComponent(serial)}/display`)
      .then((d) => {
        setInfo(d);
        setDraft(d.override ?? { width: d.nativeWidth, height: d.nativeHeight, density: d.nativeDensity });
        setCustom(false);
      })
      .catch(() => {});
  }, [serial]);
  useEffect(load, [load]);

  if (!info || !draft) return null;

  const { nativeWidth: nw, nativeHeight: nh, nativeDensity: nd } = info;
  const nativeRatio = (nh / nw) * 9;
  const presets = [nativeRatio, 19.5, 18, 16].filter((r, i, a) => r <= nativeRatio + 0.01 && a.indexOf(r) === i);
  const isNativeDraft = draft.width === nw && draft.height === nh && draft.density === nd;

  const apply = async (body: object) => {
    setBusy(true);
    try {
      await api(`/api/devices/${encodeURIComponent(serial)}/display`, { method: "POST", body: JSON.stringify(body) });
      load();
    } catch {
      /* leave draft as-is */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quality-display">
      <div className="qd-head">
        <span>裝置解析度</span>
        <span className="qd-warn">改實機</span>
      </div>
      <div className="qd-native">
        原生 {nw}×{nh} · {nd}dpi
      </div>
      <div className="qd-seg">
        {presets.map((r) => {
          const isNativeChip = Math.abs(r - nativeRatio) < 0.01;
          const h = Math.round((nw * r) / 9);
          const on = !custom && draft.width === nw && (isNativeChip ? isNativeDraft : draft.height === h);
          return (
            <button
              key={r}
              className={`qd-chip${on ? " on" : ""}`}
              onClick={() => {
                setCustom(false);
                setDraft({ width: nw, height: isNativeChip ? nh : h, density: nd });
              }}
            >
              {isNativeChip ? `原生 ${r}:9` : `${r}:9`}
            </button>
          );
        })}
        <button className={`qd-chip${custom ? " on" : ""}`} onClick={() => setCustom(true)}>
          自訂
        </button>
      </div>
      {custom && (
        <div className="qd-fields">
          <label>
            長(高)
            <input value={draft.height} onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) || 0 })} />
          </label>
          <label>
            寬
            <input
              value={draft.width}
              onChange={(e) => {
                const w = Number(e.target.value) || 0;
                setDraft({ ...draft, width: w, density: w > 0 ? Math.round((nd * w) / nw) : draft.density });
              }}
            />
          </label>
          <label>
            密度
            <input value={draft.density} onChange={(e) => setDraft({ ...draft, density: Number(e.target.value) || 0 })} />
          </label>
        </div>
      )}
      <div className="qd-res">
        套用後 →{" "}
        <b>
          {draft.width}×{draft.height}
        </b>{" "}
        · {draft.density}dpi
      </div>
      <div className="qd-acts">
        <button className="primary" disabled={busy} onClick={() => void apply(draft)}>
          套用
        </button>
        <button disabled={busy || !info.override} onClick={() => void apply({ reset: true })}>
          還原原生
        </button>
      </div>
      <div className="qd-foot">改的是手機實體螢幕,所有觀看者與旁邊真人都會看到;按「還原原生」才復原。</div>
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
        <Icon name="volumeDown" size={18} />
      </button>
      <button title="音量+" onClick={() => send({ type: "navigate", key: "volumeUp" })}>
        <Icon name="volumeUp" size={18} />
      </button>
      <button title="電源" onClick={() => send({ type: "navigate", key: "power" })}>
        <Icon name="power" size={18} />
      </button>
      <button title="把本機剪貼簿貼到手機" onClick={onPaste}>
        <Icon name="clipboard" size={18} />
      </button>
      <span style={{ flex: 1 }} />
      <button title="返回" onClick={() => send({ type: "navigate", key: "back" })}>
        <Icon name="back" size={18} />
      </button>
      <button title="主畫面" onClick={() => send({ type: "navigate", key: "home" })}>
        <Icon name="home" size={16} />
      </button>
      <button title="多工" onClick={() => send({ type: "navigate", key: "appSwitch" })}>
        <Icon name="recents" size={15} />
      </button>
      <span style={{ flex: 1 }} />
      <button title="旋轉" onClick={() => send({ type: "rotate" })}>
        <Icon name="rotate" size={18} />
      </button>
      {IS_COARSE_POINTER && (
        <button title="鍵盤" onClick={onShowKeyboard}>
          <Icon name="keyboard" size={18} />
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
