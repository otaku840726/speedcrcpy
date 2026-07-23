# speedcrcpy

自架的 Web 版 scrcpy:從電腦、手機、任何瀏覽器遠端操控你的 Android 裝置。針對弱網(蜂窩網路觀看)做了大量優化——寧可局部殘影漸進癒合,也不凍結卡頓。

```
手機 ──(無線 adb,LAN)── 伺服器(常開主機) ──(WebSocket,Tailscale/VPN/公網)── 瀏覽器
```

## 功能

- 畫面鏡像(H.264 硬解,WebCodecs)+ 觸控/滑鼠/鍵盤控制(含中文 IME)
- 音訊轉發(Opus,Android 11+)
- 雙向剪貼簿同步
- 多裝置管理:無線 adb 連線/配對、斷線自動重連、多裝置同時鏡像
- 畫質階梯(1440p → 360p)手動 + 自動調適
- 關閉被控端實體螢幕(session 頁 ☀/🌙 按鈕)以降低發熱與耗電,鏡像與觸控照常
- 弱網優化:CBR + intra-refresh 漸進刷新編碼、分塊優先級傳輸(輸入永不被視訊堵塞)、雙信號壅塞偵測(bufferedAmount + 客戶端延遲梯度)、decode-through 穿透解碼、RESET_VIDEO 亞秒重同步
- PWA:可加入手機主畫面當 App 用;鏡像時螢幕保持喚醒
- 一人控制、其他人觀看的多人檢視

## 前置需求

伺服器主機(常開的電腦/伺服器):

- Node.js 22+
- pnpm(`npm install -g pnpm`)
- Google `adb`(platform-tools;macOS: `brew install android-platform-tools`)

Android 手機:

- 開發人員選項 → 無線偵錯 開啟(Android 11+)
- 或先用 USB 連線執行 `adb tcpip 5555` 後拔線(舊機型)

## 安裝與啟動

```bash
pnpm install        # 會自動下載 scrcpy-server 3.3.4 官方 jar
pnpm build          # 打包 server 與 web
```

開發模式(前後端熱重載):

```bash
pnpm dev            # server :8000 + Vite :5173(已設 proxy)
```

正式執行:

```bash
node packages/server/dist/index.js
```

首次啟動會自動產生登入密碼並寫入 `data/config.json`(log 也會印出)。

## Docker

映像已內建 `adb`(Google platform-tools),不需主機另裝。無線 adb 走 outbound 連線,預設 bridge 網路即可連到區網手機。

從 GitHub Container Registry 拉取(main 分支每次 push 自動發佈):

```bash
docker run -d --name speedcrcpy \
  --restart unless-stopped \
  -p 8000:8000 \
  -e SPEEDCRCPY_PASSWORD=改成你的密碼 \
  -v speedcrcpy-data:/data \
  -v speedcrcpy-adb:/root/.android \
  ghcr.io/otaku840726/speedcrcpy:latest
```

`--restart unless-stopped` 讓容器在主機重開或極端情況下自動恢復。

或本機自行建置:

```bash
docker build -t speedcrcpy .
docker run -d --name speedcrcpy -p 8000:8000 -v speedcrcpy-data:/data ghcr.io/otaku840726/speedcrcpy:latest
```

- `/data` volume 保存密碼、HMAC 金鑰、已知裝置清單
- `/root/.android` volume 保存 adb 金鑰(裝置授權跨重啟保留)
- 若手機需要回連容器(極少數 Android <9 無線情境),改用 `--network host`
- **容器預設關閉被控端實體螢幕**(專用被控裝置降溫);要保持螢幕亮著加 `-e SPEEDCRCPY_SCREEN_OFF=false`

### 設定

環境變數(或 `data/config.json`):

| 變數 | 預設 | 說明 |
|---|---|---|
| `SPEEDCRCPY_PORT` | `8000` | 監聽埠 |
| `SPEEDCRCPY_HOST` | `0.0.0.0` | 監聽位址 |
| `SPEEDCRCPY_PASSWORD` | 自動產生 | 登入密碼 |
| `SPEEDCRCPY_DATA_DIR` | `./data` | 資料目錄(密碼、裝置清單、金鑰) |
| `SPEEDCRCPY_ADB_HOST` / `SPEEDCRCPY_ADB_PORT` | `127.0.0.1:5037` | adb server 位置 |
| `SPEEDCRCPY_SCREEN_OFF` | `false`(Docker 映像預設 `true`) | 每次鏡像預設關閉被控端實體螢幕 |

## HTTPS(遠端訪問必須)

WebCodecs 與剪貼簿 API 需要 secure context,遠端訪問一定要走 HTTPS:

**Tailscale(最簡單):**

```bash
tailscale serve --bg 8000
```

之後用 `https://<主機名>.<tailnet>.ts.net` 訪問。

**Caddy(公網 IP + 網域):**

```
your.domain.com {
    reverse_proxy localhost:8000
}
```

LAN 內用 `http://<主機IP>:8000` 也可以(localhost 例外允許)。

## 連接手機

1. 手機開啟無線偵錯,記下 IP:port
2. 第一次需配對:網頁裝置頁 → 配對 → 輸入配對位址與配對碼(手機「使用配對碼配對裝置」畫面顯示)
3. 輸入連線位址(通常 port 是 5555 或無線偵錯顯示的動態 port)→ 連線
4. 點「鏡像」開始

已連過的裝置會記住並自動重連(可關)。注意:`adb tcpip 5555` 模式重開機後會失效,需要重新用 USB 開啟;無線偵錯的動態 port 重開機後也會變。

## 弱網行為說明

- 網路變差時先「穿透模式」:丟掉過時幀但持續餵解碼器,畫面出現短暫殘影並在 1-2 秒內自動癒合(intra-refresh),全程不凍結
- 若瀏覽器解碼器不容忍缺參考幀,自動切「閘控模式」:暫停→排空→從新 keyframe 續播
- 持續壅塞會自動降檔(最低 360p/300kbps),恢復後 20 秒逐步升檔
- 手動選檔會鎖定上限,自動降檔仍會保護
- 📊 按鈕可看即時統計(位元率/RTT/延遲梯度/丟幀/模式)

## 安全

- 所有 API 與 WebSocket 都需要登入(HMAC token,30 天效期)
- 登入錯誤限流(每 IP 每分鐘 5 次)
- 建議只在 Tailscale/VPN 內暴露;若用公網 IP 務必配 HTTPS 且用強密碼
