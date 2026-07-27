# WebTransport 遷移設計

狀態:**設計定案,尚未動工**(2026-07-27)
目標讀者:本專案維護者

## 為什麼要做

目前傳輸走 **WebSocket over TCP**。TCP 保證可靠有序,代價是**隊頭阻塞(head-of-line blocking)**:嚴重丟包時,內核重傳會讓整條連線短暫停頓——視訊、音訊、輸入全部一起卡。這是 WS 再怎麼優化都跨不過的物理底線(現有的分塊/優先佇列/decode-through 只是把它壓到最小)。

**WebTransport(HTTP/3 over QUIC)** 提供「多條互相獨立的 stream(跨 stream 無隊頭阻塞)+ 不可靠 datagram」,是唯一能跨過這道牆、又**不是 WebRTC** 的選項。選它而非 WebRTC 的理由:

- 拓撲是 client → 固定位址的自架伺服器(Tailscale/VPN/公網),**不需要 NAT 打洞**——WebRTC 的 ICE/STUN/TURN 對我們毫無用處。
- 我們是**轉發** scrcpy 現成編好的碼流(不重編碼),WebRTC 的媒體管線(ABR/FEC/jitter buffer)用不上,最後只會走 data channel = 更複雜版的 WebTransport。
- WebTransport 讓現有的 app 層邏輯**幾乎原封保留**,只換底層傳輸;WebRTC 要整個重寫成 RTP。
- 複雜度低很多(這也是當初否決 WebRTC 的理由)。
- 前提:**不需要支援 iOS Safari**(已與使用者確認)。WebTransport 在 Safari 支援較新/較弱;桌面 Chrome / Android 沒問題。

## 設計原則

1. 消除 TCP 隊頭阻塞。
2. **沿用**現有 app 層:壅塞階梯、decode-through/gate、客戶端延遲梯度信號、intra-refresh 自癒。
3. WebSocket **保留當 fallback**。
4. 傳輸做成**可插拔**——上層(Viewer / SessionClient)不該知道底下是 WS 還是 WT。

## channel → WebTransport 原語對應

現有的 channel(見 `packages/shared/src/protocol.ts`)對應到 WebTransport 原語:

| 現有 channel | WT 原語 | 可靠性 | 優先級(`sendOrder`) |
|---|---|---|---|
| `JSON`(輸入 / hello / 畫質 / 剪貼簿 / ping-pong) | 1 條 **reliable bidirectional stream**(控制流,雙向) | 可靠有序 | 最高 |
| `VIDEO_META` / `VIDEO_CONF`(SPS/PPS) | 走**控制流**(須先於影格、可靠有序) | 可靠有序 | 最高 |
| `AUDIO_META` / `AUDIO_DATA` | 1 條 **reliable unidirectional stream**(server→client) | 可靠有序 | 中 |
| `VIDEO_CHUNK`(影格) | **Phase 1:每影格一條 unidirectional stream**;**Phase 2:datagram** | P1 每影格可靠、跨影格獨立 / P2 不可靠 | 最低 |

**核心效果**:影格各走獨立 stream,某影格掉包只會短暫卡「那一條」,不擋控制流 / 音訊 / 後續影格——正是要跨過的那道牆。

## 各設計決策

### 優先級:用 `sendOrder` 取代手動 16KB 交錯
控制流 `sendOrder` 高、音訊中、影格低,交給 QUIC 排程。現有 `send-queue.ts` 的「16KB 分塊 + 優先級交錯」是為單條 TCP 隊頭阻塞而做的 workaround,**WT 下可移除**(影格整包寫進它的 stream,QUIC 自己切段)。淨簡化。

### 壅塞控制:保留延遲梯度,替換 bufferedAmount
- **保留**客戶端延遲梯度(ping/pong,`congestion.ts`)——與傳輸無關,當主信號。
- 本地 `bufferedAmount` 信號 → 改用 **WT stream backpressure**(writer `ready` promise 遲遲不 resolve = 積壓)或自記 outstanding bytes。
- **階梯 + decode-through/gate 邏輯不動**(吃的是同樣的抽象信號)。

### 「只渲染最新」→ 主動放棄過期影格
影格各自 stream:更新的影格到、或當前影格太晚時,**reset 掉舊影格的 stream**,不浪費頻寬重傳過期影格。對應現有的「只渲染最新幀」。壅塞時少開新 stream / reset 在途的 = 現在 gate 的等價。

### META/CONF 與影格的順序競態
影格走別條 stream,可能比控制流的 META/CONF 先到。**沿用**客戶端 `video-pipeline.ts` 既有防護(拿到 config + keyframe 前不餵解碼器:`configWritten` / `awaitingKeyframe`),競態自動吸收。

### 認證
Token 放 WT URL query(同現在 WS 的 `?token=`),server 在 session-request handler 驗;或當控制流第一則訊息送。沿用現有 `auth.ts`。

## 需要動的檔案

### Phase 0 — 抽傳輸介面(不改行為,降風險)
- 從 `packages/server/src/transport/send-queue.ts` 抽出 `ViewerSink` 介面:
  `sendControl / sendVideoMeta / sendVideoConf / sendVideoFrame / sendAudioMeta / sendAudioData / clearVideo / (backpressure 信號) / close`。
- `viewer.ts` 改吃 `ViewerSink`(不再直接綁 `ws`);`congestion.ts` 讀 sink 的 backpressure。
- 實作:`WsSink`(把現況搬進去)。
- 客戶端 `packages/web/src/core/session-client.ts` 抽 `Transport` 介面;實作 `WsTransport`(現況)。
- **驗收**:行為與現在完全一致(WS 照跑),只是多了一層介面。

### Phase 1 — 加 WebTransport(WS 仍在,可 fallback)
- 伺服器新增 `packages/server/src/http/webtransport-gateway.ts`(對照 `ws.ts`),用 **`@fails-components/webtransport`**(Node HTTP/3 endpoint,獨立 UDP port,如 :8443)。
- 實作 `WtSink`:控制流(bidi)+ 音訊流(uni)+ 每影格一條 uni stream + `sendOrder` 優先級 + reset 過期影格。
- 客戶端 `WtTransport`:`new WebTransport(url)` → 開控制 bidi、收 incoming unidirectional streams(音訊 / 影格)。
- **Fallback**:`window.WebTransport` 存在且連得上就用 WT,否則退 WS。協定語意(channel / 訊息)完全相同,上層無感。
- **驗收**:WT 下功能與 WS 等價;`tc netem` 弱網下掉包不再讓畫面 / 輸入停頓。

### Phase 2(可選)— 影格改 datagram
- 若 Phase 1 每影格 stream 在重丟包下仍卡,把影格改 datagram(~1100 B/顆 + 沿用現有 `[frameId][chunkIdx/total]` header 重組),達成真正的「部分影格 = 馬賽克、intra-refresh 癒合」。
- 解碼器容忍不足時退回既有的 `decoderError → gate`。

## 風險 / 基建

- **native 依賴**:`@fails-components/webtransport` 含 QUIC native 元件 → 破「純 JS」原則;**須確認 arm64 有 prebuilt**(Docker 是 amd64 + arm64)。
- **TLS + UDP + 憑證**:HTTP/3 需有效憑證 + 開 UDP port。**反向代理對 WebTransport 的 passthrough 很麻煩**,實務上多半讓 WT server 直接終結 TLS;走 Tailscale/VPN 直接開 UDP 最單純。
- QUIC 加解密比 TCP 略吃 CPU(幾條 stream 無感)。
- datagram 大小上限(僅 Phase 2 需處理)。

## 驗證計畫

`tc netem` A/B:**WS vs WT(Phase 1)vs WT-datagram(Phase 2)**,在 2 Mbps + 5% 丟包 + 50 ms 抖動下量:
- glass-to-glass 延遲
- 凍結 / 停頓次數
- 輸入延遲

目標:WT 下「掉包不再讓畫面或輸入停頓」,且延遲有界不累積。

## 現況備註

- 傳輸層(WS)已優化到 TCP 這條路的實務極致;本遷移是「跨過 TCP」的下一步。
- 編碼側已支援 H.264 / H.265 即時切換(H.265 省頻寬),與本遷移正交、互補。
