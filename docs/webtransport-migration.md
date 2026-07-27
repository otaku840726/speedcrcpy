# WebTransport 遷移設計

狀態:**已實作並部署到生產環境**(2026-07-27)。Phase 0 / 1 / 1.5 完成;Phase 2 目前不需要。
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

## 實作狀態

### Phase 0 — 抽傳輸介面(不改行為) ✅ commit 7227246
- 伺服器 `packages/server/src/transport/sink.ts` 定義語意化 `ViewerSink`:
  `sendControl / sendVideoMeta / sendVideoConf / sendVideoFrame / sendAudioMeta / sendAudioData / clearVideo / close` + backpressure getters(`bufferedBytes / sentBytes / droppedFrames`)+ 收發回呼(`onMessage / onClose`)。
- framing 從 `viewer.ts` 移入 `transport/ws-sink.ts`(`WsSink`,內含既有 `SendQueue`);`viewer.ts` / `congestion.ts` 改吃介面。
- 客戶端 `packages/web/src/core/session-client.ts` 抽 `SessionTransport` 介面、原 class 改名 `WsTransport`、新增薄 `SessionClient` facade。
- 行為零改變,WS 照跑(真機驗證)。

### Phase 1 — 加 WebTransport(WS 保留 fallback) ✅ commit 42aa334
- 伺服器 `packages/server/src/http/wt-gateway.ts`(`Http3Server`,`@fails-components/webtransport` + 原生 `-transport-http3-quiche`)、`transport/wt-sink.ts`(`WtSink implements ViewerSink`:控制 bidi + 音訊 uni + 每影格 uni)、`transport/wt-cert.ts`(`@peculiar/x509` 自簽 ECDSA + DER hash)。
- 認證:serial + token 走**控制流第一則 attach 訊息**(QUIC 無 cookie,`sessionStream` 精確比對路徑、query 會讓握手失敗);token 由 `/api/wt-info` 發。
- 憑證:自簽 + `serverCertificateHashes`(ECDSA P-256、≤14 天,免 CA);有 CA 憑證(反代 / Tailscale)時 `/api/wt-info` 的 `certHash` 回 null、client 免 hash。
- 客戶端 `core/wt-transport.ts`(`WtTransport`);`SessionClient.pick()` 問 `/api/wt-info` 選 WT/WS,首連失敗自動退 WS。
- 設定:`SPEEDCRCPY_WT_ENABLED`(預設 false)/ `SPEEDCRCPY_WT_PORT`(8443)。

### Phase 1.5 — 弱網丟幀修正 ✅ commit 811cc20
Phase 1 naive 版在手機/弱網下**比 WS 更差**(真機重現:RTT 383ms、丟幀、可見 macroblock 汙染)。原因與修法:
- **每影格獨立 stream 不保證順序**,客戶端原本按 stream 讀完順序餵解碼器 → 亂序 → WebCodecs decode error → 重建循環 + 馬賽克。
  → 客戶端加**依 frameId 重排緩衝**:照解碼順序餵、視窗 8 幀、gap 填不滿就跳過缺幀(靠 intra-refresh 癒合)、丟過期遲到幀、reconnect 重置(server frameId 每連線從 0)。
- **in-flight cap = 3 太小**:RTT>50ms 就純因延遲丟幀(380ms 路徑合理有 ~23 幀在途)。→ cap 3→64,只當 runaway guard。
- **`sendOrder` 設反了**(原本新幀優先反而製造亂序)。→ 改**舊幀優先**(`-id`)。
- **`bufferedBytes` 累加在途幀位元組 = BDP → 誤判壅塞**。→ 改 flow-control 阻塞中的 `outstandingBytes`。
- 教訓:上面「只渲染最新 → server reset 過期影格」不足以處理**影格間**亂序,真正的解是客戶端重排 + 跳幀;「META/CONF 順序競態」談的是 META-vs-影格,實際更大的坑是**影格-vs-影格**。

### Phase 2(可選,目前不需要)— 影格改 datagram
- 若某天每影格 stream 在極端丟包下仍卡,再把影格改 datagram(~1100 B/顆 + `[frameId][chunkIdx/total]` header 重組)。Phase 1.5 後弱網已明顯改善,暫不需要。

## 風險 / 基建(實測結果)

- **native 依賴**:`@fails-components/webtransport-transport-http3-quiche`(NAPI v6)在 **darwin-arm64 / linux-x64 / linux-arm64 都有預編譯**(GitHub release),`prebuild-install` 直接下載,Docker(amd64+arm64)**無需 cmake 原始碼建置**。pnpm 需在 `pnpm-workspace.yaml` 的 `allowBuilds` 核准其 build script。→ 「arm64 prebuilt」風險解除。
- **TLS + UDP + 憑證**:WT 自己終結 TLS、跑獨立 UDP port,**不能走 TCP 反向代理**。自架情境:防火牆把該 UDP port DNAT 直達容器(繞過反代);自簽走 `serverCertificateHashes`、正式憑證免 hash。**企業防火牆(如 Sophos)常預設封 QUIC** → 要在對應規則放行 UDP + 關 QUIC 阻擋,否則 QUIC 到不了伺服器(client 會自動退 WS)。生產已在 Sophos 後方跑通(UDP :50300)。
- QUIC 加解密比 TCP 略吃 CPU(無感)。
- **版本探測 / 部署**:`/api/health`(免認證)回 `{ok, version, builtAt}`,`version` = image 烤進去的 git SHA(Dockerfile `ARG GIT_SHA`,CI 帶入);push → CI → Watchtower 自動更新生產,可輪詢 `/api/health` 確認新版上線後自我驗證。

## 驗證計畫

`tc netem` A/B:**WS vs WT(Phase 1)vs WT-datagram(Phase 2)**,在 2 Mbps + 5% 丟包 + 50 ms 抖動下量:
- glass-to-glass 延遲
- 凍結 / 停頓次數
- 輸入延遲

目標:WT 下「掉包不再讓畫面或輸入停頓」,且延遲有界不累積。

## 現況備註

- 傳輸層(WS)已優化到 TCP 這條路的實務極致;WT 是「跨過 TCP」的下一步,已上線並在弱網下驗證改善(Phase 1.5 後),WS 保留為 fallback。
- 編碼側支援 H.264 / H.265 即時切換(H.265 省頻寬),與本遷移正交、互補。
