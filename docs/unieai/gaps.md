# 還沒接上的東西（盤點）

這份文件記錄「rabi／DSH 有的能力，UnieAI Code 還沒接出來」的現況，作為排工作順序
與稽核的依據。每一項都附上判斷所依據的檔案與行號；行號會隨改動漂移，查證時以符號
名稱為準。最後盤點日期：2026-11-23（對應 0.0.45／0.0.46）。

Rabi Harness 的起法只有一種：`rabi --profile acp`，再疊上本專案的 patch
（`agent-runtime/src/unieai-rabi/config.mjs`）。ACP 是一條窄門，很多 rabi 的功能
不是「沒開」，而是 ACP 沒有出口——這是下面分類的依據。

## 一、已經接上（可以在 TUI 用到）

| 能力 | 入口 |
|---|---|
| 常駐 shell、背景 session、輸出上限（`exec_command`／`write_stdin`） | `unieai-catalog.mjs`、`engine.mjs` |
| 檔案讀寫、diff 卡、讀後改、模糊比對 | `unieai-catalog.mjs`、`engine.mjs` |
| skills（含 bundled 的 artifact skill） | `config.mjs` |
| `web_search`（走 UnieAI gateway）、`web_fetch` | `unieai-catalog.mjs` |
| `describe_image`（文字模型看圖） | `unieai-catalog.mjs` |
| 機密遮蔽（金鑰不進 prompt） | `unieai-catalog.mjs` |
| `ask_user_question`、plan 審核回流 | `unieai-control.mjs` |
| `publish_artifact` | `config.mjs` |
| `create_worktree` | `config.mjs` |
| 子代理：`subagent`／`subagent_fork`／`wait_agents` | `unieai-catalog.mjs`、`unieai-control.mjs` |
| rewind／fork（每回合 shadow-git 快照） | `engine.mjs` |
| 權限：sandbox／核准／自動審查 | `config.mjs`、`unieai-control.mjs` |
| 用量與上下文佔用、`/context` | `engine.mjs` |
| 排程：`schedule_wakeup`、`cron_*`、`/loop` | `unieai-catalog.mjs`、`unieai-control.mjs` |
| 持久 goal（`/goal`） | `unieai-control.mjs` |
| 壓縮、todo→計畫清單、回合結束守門 | `engine.mjs`、`unieai-catalog.mjs` |
| 跨 session 全文搜尋：`session_search`、`session_event_search`、`session_event_read`、`session_event_trace`、`session_trace` | `config.mjs`（`session-query-sqlite` 改 `openAt: first-search` ＋ 插入 `tool-session-query`） |
| Ralph 長跑：`ralph` | `config.mjs`（插入 `tool-ralph`，沿用 profile 既有的 `spawn` 子代理與 workflow 引擎） |
| 思考強度與 Thinking 區塊 | 見 [reasoning.md](reasoning.md) |

## 二、沒接上（依價值÷成本排序）

| 項目 | 現況 | 要改哪裡 | 成本 |
|---|---|---|---|
| 工具卡分組 | `engine.mjs` 的 `TOOL_NAMES` 只認六組工具，goal／workflow／publish_artifact／wait_agents／cron／worktree／plan 都是散落的獨立卡 | `engine.mjs` 補名字，`codex-rs/tui/src/scrollback_verb_group.rs` 的詞彙表同步 | 小 |
| Plan 模式（進入） | rabi 的 plan-mode 外掛是開著的，但 ACP 不轉送 rabi 的 slash command；TUI 的 `/plan` 在 uac 顯示 coming soon | `unieai-control.mjs` 加一個 planMode 方法（照 `/loop` 的寫法），再解 `slash_command.rs` 的 gate | 中 |
| Agent Teams | 見下一節 | 見下一節 | 中 |
| rabi session 列表 | ACP 有 `session/list`，`agent-runtime` 從不呼叫 | `engine.mjs` 加呼叫；`/resume` 可改用它 | 中 |
| PTC 模式 | 需要 rabi web app 的 `cordisInspect`，ACP 底下是空殼；已從選單移除 | 不建議接 | — |
| 語音輸入 | 需要 TUI 自己做錄音與上傳 | — | 大 |
| session 標題每輪更新 | rabi 的 `session-title-llm` 在 ACP profile 被關掉；改成「每輪都請 LLM 重算」等於每回合多一次模型呼叫，而 uac 從不把 rabi 的 session 標題顯示出來 | 不建議接（除非 TUI 要顯示標題） | — |

搜尋與 Ralph 這一批的驗證方式（2026-11-23）：把 `config.mjs` 產生的 patch 疊在
一份 rabi home 的複本上，用 `--dump-config` 確認 `session-query-sqlite` 是
`openAt: first-search`、兩筆 insert 都在組出來的樹裡；再用 ACP 連上去開一個
session，確認送給模型的工具清單含 `session_search`／`session_event_*`／
`session_trace`／`ralph`（共 40 個工具，原為 34 個），並實際呼叫一次
`session_search`，回傳了這個 workspace 既有的 9 個 session 標題。

## 三、團隊（Agent Teams）

rabi 的團隊是一層 profile overlay：先關掉四個直派子代理工具
（`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、
`tool-subagent-fork`），再插入 `agent-team`（上限 8 名成員、256 個任務、
單訊息 64 KiB）、`tool-agent-team` 與只有 web client 能用的 `ui-agent-team`。

工具面是「隱含 root 的 roster ＋ 共享任務 DAG」：`spawn_teammate`、
`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、
`team_task_create/list/get/update`。

**今天不能用**：uac 只走 `--profile acp`，不碰 `OPTIONAL_BUNDLES`；唯一的例外是
worktree，因為 `config.mjs` 直接插了那個實驗 bundle。

要接的話，四件事：

1. patch 生成：照 `config.mjs` 插 worktree 的寫法，插 4 條 `disabled: true` 加 2 條
   插入（不要插 `ui-agent-team`），或收成一筆 catalog entry。約 20 行。
2. `engine.mjs` 的 `TOOL_NAMES` 補 team 工具名，並考慮把 `send_message`／
   `wait_agent` 放進 `QUIET_WHEN_OK`，否則每次呼叫都是一張卡。
3. **子代理面板會空白**（成本最大）：面板靠 uac 把 `subagent/start|end` 轉成
   `onSubagent`，而 team 不發這組事件；要新增 team 事件一路轉到 Rust 面板。
4. 與現有 `wait_agents`、`/agents`、`/tasks` 語意重疊，要挑一套並寫明。

建議順序：先做 1＋2（team 至少能在對話裡跑起來），面板另開一輪。

## 四、ACP 這道門本身漏掉的

| 現象 | 後果 |
|---|---|
| `config_option_update` 沒處理 | rabi 自己換模型／強度後，TUI 的標示不會更新 |
| 沒有 `session/set_mode`、`session/load`、`availableCommands` | rabi 的 slash command（`/plan`、`/permission`、`/compact`）任何 ACP client 都摸不到；uac 的 `/loop`、`/goal`、`/context` 是自己重做的 |
| `prompt` 就是普通使用者訊息，不解析 `/` | 想在 uac 用 rabi 原生指令，只能由 uac 轉譯 |
| 權限只有 `allow_once`／`reject_once` | 「本 session 一律允許」只能由 client 自己記；rabi 的細緻 preset 傳不進來 |
| 不發 `plan` 的 sessionUpdate | 計畫清單是 uac 自己攔 `todo_write` 轉的，真正的 plan-mode 計畫無法呈現 |
| client 能力全關（`fs`、`terminal` 都是 false） | rabi 只能用自己的檔案／終端工具；`cordisInspect` 這類 host-runner 能力也一併排除 |

## 五、slash command 的空殼與沒接

`/engine`、`/model`、`/permissions`、`/compact`、`/fork`、`/goal`、`/agents`、
`/tasks`、`/mcp`、`/worktree` 等在那兩個引擎上都可用。以下是還沒有動作的：
  
| 指令 | 現況 | 接法 | 成本 |
|---|---|---|---|
| `/debug-m-drop` | **已接**：兩引擎都走 `AppEvent::ResetMemories` → `memory/reset` | — | — |
| `/loop`（codex 引擎） | **已接**：選單仍只列在 uac 上，直接打在 codex 會回「needs the rabi engine」而不是被當成訊息送出 | — | — |
| `/app` | 永遠 coming soon，`codex://` deeplink 也不屬於本產品 | 先決定桌面版有沒有自己的 deeplink；沒有就把文案改成「不支援」 | 中 |
| `/debug-m-update` | 空殼；協議沒有這個方法 | 先在協議加 `memory/consolidate`，再加路由 | 大 |
| `/review`、`/side`、`/btw`、`/memories`、`/hooks`、`/plugins`、`/plan` | uac 上標 coming soon | 各自要看 ACP 有沒有出口；`/plan` 最有機會（見第二節） | 中～大 |
| `/goal`、`/usage`、`/worktree` | feature 關閉時靜默或被過濾，使用者看到「Unrecognized command」 | 套用既有的 `soon(cmd)` 樣板給一句原因 | 小 |
