# Design: chat-panel-app-server

## 架構總覽

```
┌────────────── VS Code extension host ──────────────┐
│  ChatViewProvider                                   │
│    ├── AppServerClient (新)                          │
│    │     spawn `unieai app-server` (stdio, 常駐)     │
│    │     JSON-RPC: requests / responses / notifs    │
│    │     server→client requests: 核准請求            │
│    ├── ExecFallback (現有 runTurn，降級路徑)          │
│    └── SessionStore (rollout 掃描，沿用)             │
└───────────────┬─────────────────────────────────────┘
                │ postMessage（改版協定，見下）
┌───────────────▼───────────── webview ───────────────┐
│  transcript renderer（delta 緩衝、核准卡、diff）      │
└──────────────────────────────────────────────────────┘
```

## 關鍵決策

### D1: 常駐 app-server（非每回合 spawn）
- 一個 workspace 一個 process，`initialize` 一次，thread 跨回合復用
- 好處：串流 delta、核准雙向通道、無每回合啟動延遲（exec 每回合 ~2-4s）
- process 監控：exit 非零 → 顯示錯誤 → 降級 exec fallback；閒置 30 分鐘不回收（記憶體換延遲）

### D2: 協定盤點先行（tasks 第一項）
以 `codex-rs/app-server-protocol/src` 為權威盤點實際方法名與 payload：
- 生命週期：`initialize` → `thread/start`（或 resume）→ 送 user turn → 通知流
- 核准：server→client request（exec/patch approval elicitation），client 以 request id 回覆 allow/deny
- 串流：agent message delta / reasoning delta / item 通知
- TUI 的 `app_server_session.rs` 與官方測試 `app-server-test-client` 是用法範例
盤點結果落在 `design-notes/protocol-inventory.md` 後才動工。

### D3: 權限膠囊 → approval policy 映射
| 膠囊 | sandbox | approval policy |
|---|---|---|
| 預設權限 | workspace-write | on-request（核准卡） |
| 唯讀 / 規劃 | read-only | never |
| 完全存取 | danger-full-access | never |
「上網」膠囊維持 network_access config。「永遠允許」只記在 session（Map<approvalKey>），不落盤。

### D4: webview 訊息協定 v2 — 串流粒度以協定為準
app-server v2 原生提供 delta 事件（AgentMessageDelta、ReasoningTextDelta、
CommandExecutionOutputDelta、PlanDelta…）：**協定給什麼粒度就渲染什麼粒度**，
不自行切分或聚合語意。
ext→webview：`turnDelta{itemKey,kind,text}`、`itemUpsert{item}`、`approvalRequest{id,kind,summary,detail}`、`turnState{running|interrupted|failed,retryable}`、`subagent{threadId,parentItemKey,state,summary}`、其餘沿用。
webview→ext：`approvalReply{id,decision}`、`retry`、其餘沿用。
Delta 緩衝僅為渲染效能（rAF 批次 append），不改變事件語意。

### D5: diff 渲染
app-server patch 事件帶 unified diff → webview 以行級著色（+ 綠 / - 紅 / @@ 藍灰），檔名列可點 → `openUrl` 改 `openFile{path,line}` → `vscode.window.showTextDocument`。無 diff 資料時退回現有 +/-/~ 清單。

### D6: 降級策略
AppServerClient 啟動失敗（binary 舊、協定不合、crash×3）→ 一次性 notice「已降級為基本模式」→ 走現有 exec 路徑。webview 不感知差異（同一協定 v2，fallback 不發 approvalRequest/delta 而已）。

## 風險

- app-server 協定屬 codex 內部演進面：以「盤點時鎖定方法名 + fallback」緩解；升級 codex 基底時跑本 change 的 smoke 清單
- 核准請求在 webview 隱藏時到達：activity bar badge + OS 通知（`vscode.window.showInformationMessage` 帶按鈕，可直接核准）
- 常駐 process 洩漏：deactivate() kill；window reload 由 VS Code 自動回收 child
