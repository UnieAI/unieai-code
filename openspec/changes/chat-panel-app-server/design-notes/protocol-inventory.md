# App-server 協定盤點（2026-07-17，基底 codex 38b064c31 / unieai-codex）

實證方式：`handshake.mjs` 對真實 binary + demo gateway 跑通完整回合（見同目錄）。

## Transport
- `unieai app-server`（預設 stdio），**每行一個 JSON**（JSONL）
- 信封：request `{id, method, params}`；response `{id, result|error}`；notification `{method, params}`（無 `jsonrpc` 欄位）
- server→client request 同樣帶 `id`+`method`，client 回 `{id, result}`

## 生命週期（已實跑）
| 方法 | 方向 | 重點 |
|---|---|---|
| `initialize` | C→S | `{clientInfo:{name,title,version}, capabilities:{experimentalApi:true}}` → userAgent/codexHome |
| `thread/start` | C→S | `{model, cwd, approvalPolicy, sandbox, ephemeral?}`（camelCase）→ `{thread:{id,...}}` |
| `thread/resume` | C→S | `{threadId}` 接續舊 thread |
| `thread/settings/update` | C→S | `{threadId, cwd?, approvalPolicy?, sandbox?…}` 後續回合生效（權限膠囊中途切換用） |
| `turn/start` | C→S | `{threadId, input:[{type:"text", text}]}` → `{turn:{id,status:"inProgress"}}` |
| `turn/interrupt` | C→S | `{threadId, turnId}` |

## 串流通知（已實收）
- `turn/started` / `turn/completed`（`turn.status: completed|…`）/ `thread/status/changed`
- `item/started` / `item/completed`：`{item:{type,id,...}, threadId, turnId}`；item type 為 camelCase：`userMessage`、`agentMessage{text}`、`commandExecution`、`fileChange`、`reasoning`、`plan`…
- Delta：`item/agentMessage/delta`、`item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`item/fileChange/outputDelta`、`item/plan/delta` — `{threadId, turnId, itemId, delta}`
- 其他可忽略雜訊：`configWarning`、`remoteControl/status/changed`、`thread/tokenUsage/updated`、`account/rateLimits/updated`

## 核准（server→client request）
- `item/commandExecution/requestApproval`：params `{threadId, turnId, itemId, startedAtMs, …}`；回覆 `{id, result:{decision}}`
- `item/fileChange/requestApproval`：同型
- decision（camelCase）：`accept` / `acceptForSession` / `decline` / `cancel`（另有 execpolicy/network amendment 進階值，不用）

## Subagent / 計畫
- thread 物件帶 `parentThreadId`（subagent 子 thread），`ThreadSource::Subagent`
- `item/plan/delta` 更新計畫卡

## 註記
- `initialize` 前不可發其他請求（`Not yet initialized` 錯誤）
- 未信任專案會發 `configWarning`（面板過濾即可）
- opt-out：`capabilities.opt_out_notification_methods` 可關掉不需要的通知
