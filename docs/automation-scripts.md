# 自動化腳本 設計

狀態:**設計定案 + 可行性已驗證,尚未動工**(2026-07-28)
目標讀者:本專案維護者

## 可行性驗證(2026-07-28,丟棄式 spike)

- **OpenCV.js `matchTemplate`(最大未知)✅**:`@techstark/opencv-js`(WASM,無原生編譯)在 Node 載入 OK。`TM_CCOEFF_NORMED` 模糊比對——模板加「亮度 +40、雜訊 ±25」仍相似度 **0.992**,不存在時 **0.000**(門檻乾淨分辨)。效能:1080×2400 全幀 **~68ms**、縮 50% **~11ms**;因 `screencap`(~200–500ms)才是瓶頸,比對成本幾乎可略。**`cv.imdecode` 可直接解 screencap 的 PNG → Mat**(免另外 PNG 解碼庫)。
- **`screencap` / `adb shell input`(真機 XQ-AS72 實測)✅**:`exec-out screencap -p` → PNG 約 **0.32–0.45s**;`input tap` 暖機後 **~70ms**、`swipe` ~0.42s、`keyevent` ~0.09s。座標空間 = **邏輯解析度(= screencap 尺寸 = input 座標)**;此機 `wm size` 為 Physical 1080×2520 / Override 1080×1920,screencap 就是 1080×1920。
- **螢幕必須喚醒才有畫面(spike 抓到的關鍵細節)**:睡眠中 screencap 是全黑(~12KB);`input keyevent 224`(WAKEUP)喚醒後 screencap 才有真實內容(~515KB)。→ **引擎執行前要先喚醒顯示**,鎖屏無 PIN 時**上滑解鎖**(有 PIN 則無法,需使用者自理)。可能還要在腳本執行期間維持喚醒(wakelock / `svc power stayon` / 關屏 keeper 的合成保活)。
- 結論:全綠。視覺堆疊 = **喚醒 → screencap → cv.imdecode → matchTemplate(TM_CCOEFF_NORMED,可縮放加速)→ input**;單圈約 screencap(~350ms)+ 比對(~11–68ms)+ 動作(~70ms)≈ 每秒約 2 次。

## 目標

在 UI 上編輯、儲存、執行「視覺自動化腳本」——依**座標顏色**或**圖像模糊比對**做點擊/滑動,支援迴圈與條件,可**排程定時**執行並依**優先權搶佔**。典型用途:遊戲掛機/農場、每日定時活動、簽到。

## 架構決策

- **引擎跑在伺服器端,完全用 adb,獨立於瀏覽器/scrcpy session**:
  - 視覺 = `adb screencap`(已有縮圖那套基礎;螢幕關著也能抓)。
  - 動作 = `adb shell input tap/swipe/text` + `input keyevent`。
  - → 裝置上**沒開任何 viewer session 也能跑腳本**,真正「擺著跑」。
- **每台裝置同一時間只跑一支腳本**(見〈排程與優先權〉);以背景任務執行。
- 瀏覽器 UI 只負責**編輯 + 取值 + 啟停 + 看狀態/log**。

## 座標與視覺

- **座標一律正規化(0–1)**:換解析度(見 `docs/*`/解析度覆寫功能)、旋轉都不會壞;執行時用當下 `wm size` 換算像素。
- **色彩比對**:某正規化點的 RGB 與目標色比,帶**容差**(%);用來做「等待顏色 / 若顏色」。
- **圖像比對(主力)**:**OpenCV.js(WASM,無原生編譯、Docker 友善)** `matchTemplate` + `TM_CCOEFF_NORMED` → 得最佳位置 + **相似度分數(0–100%)**;超過使用者設的**相似度門檻**就點它的中心(可加偏移量)。
  - 「模糊」= 相似度門檻(容許亮度/小差異)。
  - 可限**搜尋區域**加速。
  - **限制**:template matching **不抗縮放**——模板綁「擷取時的解析度」;跨解析度可能失準。對策:模板記錄擷取解析度、必要時做**多尺度比對**(階段三,略吃 CPU)。尺度/旋轉全免疫的特徵比對(SIFT/ORB)更重,MVP 不做。
  - 視覺頻率受 `screencap` 限制(每張約 200–500ms)→ 約每秒 2–5 次判斷;適合掛機/回合制,不適合快節奏。
- 影像處理堆疊:screencap PNG 解碼(pngjs / sharp)→ 像素 → OpenCV.js 比對。

## 取值 UX(核心)

每個座標/顏色/模板參數旁有「拾取」鈕:
- **座標/顏色**:按下 → 伺服器抓一張 screencap 疊上來 → 點一下畫面 → 存**正規化 (x,y) + 該點顏色**。
- **模板**:按下 → 在 screencap 上**框選矩形** → 存成模板(base64 PNG + 擷取時解析度)。

## 排程與優先權搶佔

- 每支腳本有:
  - **觸發**:`手動` / `常駐`(持續跑,搶佔後自動恢復)/ `排程`(每日 HH:MM、間隔、特定時間)。
  - **優先權**(整數;或 高/中/低)。
- **每台裝置永遠跑「當下最高優先的『啟用中』腳本」**:
  - `常駐` = 一直啟用(直到手動停)。`排程` = 到點啟用、**跑完**(有限)後停用到下次。`手動` = 按執行到跑完/停。
  - 優先序:**人為手動操作 > 排程腳本 > 常駐腳本**。
  - **搶佔**:更高優先者啟用(排程到點 / 你手動接手)→ 當前者暫停;高優先者**跑完 / 你放手**後,裝置自動**落回下一個最高的啟用腳本**(常駐就這樣恢復)。
  - **恢復 = 從頭重跑**(遊戲狀態已變,從中間接續危險)。
  - **前提**:搶佔者必須是**有限、會結束**的(定時活動跑完就結束),否則常駐永遠回不來。
- **時區**:排程用伺服器時鐘 +（可設）時區。

## 腳本模型(JSON)

```
Script { id, deviceSerial, name, trigger, priority, steps: Step[] }
Step 種類:
  tap        { x, y }                         // 正規化
  swipe      { x1,y1, x2,y2, durationMs }
  wait       { minMs, maxMs }                 // 區間=隨機(防偵測);相等=固定
  text       { value }
  key        { name: back|home|recents|... }
  waitColor  { x, y, color, tolerance, timeoutMs }
  ifColor    { x, y, color, tolerance, then: Step[], else?: Step[] }
  findTap    { template, threshold, region?, timeoutMs, offset? }   // 找圖點擊
  ifImage    { template, threshold, region?, then: Step[], else?: Step[] }
  loop       { count: number|∞, body: Step[] }
```

## UI 放置

- **裝置底下的「腳本」分頁**:該台的腳本清單 + 編輯器(步驟清單、拖曳排序、參數 + 拾取)+ 啟停 + log。取值用該台當下畫面。
- **全域「排程總覽」**:一眼看所有裝置的腳本/觸發/優先權/當前搶佔狀態 + 下次觸發。

## 執行引擎

- 直譯 JSON(迴圈/條件遞迴)。每裝置單一 runner + 搶佔器。
- 狀態(執行中/暫停/待命、當前步、迴圈計數)+ log 經 WS events(或輪詢)回報 UI。
- 每步動作後尊重 `screencap` 節流;視覺步驟輪詢到命中或逾時。

## API 與儲存

- CRUD:`/api/devices/:serial/scripts`(list/create/update/delete)。
- 執行:`POST /api/scripts/:id/run`、`/stop`;狀態 `GET`(或 WS 推播)。
- 模板/腳本存 `data/scripts.json`(+ 模板 base64 或 `data/templates/`)。排程狀態存記憶體 + 持久觸發設定。

## 風險 / 限制

- **速度**:screencap 每秒 2–5 次;快節奏不行。
- **座標脆**:優先用顏色/找圖,座標存正規化。
- **找圖不抗縮放**:模板綁解析度;多尺度是階段三。
- **CPU**:多裝置同跑要控制頻率/搜尋範圍。
- **反自動化**:部分遊戲偵測非人時序/adb input;隨機延遲只是緩解,不保證。
- **工程量大**:分階段。

## 分期

- **階段一(MVP)**:伺服器引擎 + 步驟直譯 + 動作(tap/swipe/text/key)+ **色彩比對** + **找圖點擊/若找到圖(OpenCV.js)** + `重複` + `若…(含 else)` + 手動執行 + 取值 UX(拾取/框選)+ per-device 編輯器 + 狀態/log + 儲存。
- **階段二**:排程(每日/間隔)+ 優先權搶佔 + 常駐 + 人為插手暫停/恢復 + 全域排程總覽。
- **階段三(可選)**:OCR、變數/計數器、多尺度找圖、while、進階編輯器 / JS 沙箱。

## 決策記錄

- 引擎:**伺服器端**(使用者定案)。
- 編輯器:綁裝置「腳本」分頁 + 全域排程總覽。
- 迴圈/條件:MVP 做 `重複` + `若顏色/若找到圖(含 else)`;while/變數排階段三。
- 找圖點擊:**列入 MVP**(使用者要求,視覺自動化主力)。
