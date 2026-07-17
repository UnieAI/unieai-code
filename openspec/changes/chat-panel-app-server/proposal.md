# Proposal: chat-panel-app-server

## Why

聊天面板目前用 `unieai exec --experimental-json`（每回合 spawn、單向 JSONL），因此**無法互動核准**——agent 要嘛被 sandbox 擋死、要嘛全自動放行，也拿不到細粒度串流與 diff 資料。這是 UX-NOTES 待辦清單裡所有大項（互動核准、diff 檢視、重試、逐字串流）的共同前置。

## What Changes

- 聊天面板後端從 `exec` JSONL 遷移到 **`unieai app-server`**（stdio JSON-RPC，與官方 Codex IDE 插件同一協定），extension host 維護單一常駐 app-server process 與 thread 生命週期
- **互動核准**：指令執行 / 檔案修改的核准請求以卡片形式進入 transcript（允許一次 / 永遠允許 / 拒絕），權限膠囊改映射 approval policy + sandbox 組合
- **逐字串流**：agent 訊息以 delta 即時渲染（取代 item 級整段更新），thinking 同步進折疊區
- **diff 檢視**：file_change 顯示彩色 unified diff，可一鍵在編輯器開啟該檔
- **重試與中斷標記**：turn.failed 顯示重試按鈕；Stop 後插入「已中斷」列
- 舊 exec 路徑保留為 fallback（app-server 啟動失敗時降級，功能回到現狀）
- **BREAKING**（內部）：webview ↔ extension host 訊息協定全面改版

## Capabilities

### New Capabilities
- `chat-backend`：app-server process 生命週期、JSON-RPC 客戶端、thread 管理、exec fallback
- `chat-approvals`：核准請求的呈現、回覆、逾時與記憶（session 內「永遠允許」）
- `chat-transcript`：串流渲染（delta、thinking、工具、diff、中斷/失敗/重試）

### Modified Capabilities
（無既有 spec——本 change 首次建立 specs）

## Impact

- `sdks/vscode/src/extension.ts`：新增 AppServerClient（stdio JSON-RPC framing、request/notification 分發）
- `sdks/vscode/src/webview/chat.js`：訊息協定改版、核准卡片、diff 渲染、delta 緩衝
- 依賴 codex-rs `app-server-protocol` 的方法/通知形狀（以 `codex-rs/app-server-protocol/src` 為權威，實作前先盤點）
- 不動 CLI/TUI/core 任何 Rust 程式碼（純 extension 工程）
