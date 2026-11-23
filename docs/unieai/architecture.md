# 架構

UnieAI Code 把兩個 agent harness 接上 UnieAI 平台：OpenAI codex（Rust）與
Rabi Harness（rabi，經 ACP 驅動）。面板與 `/engine` 可在兩者之間切換。

> 名稱：對使用者顯示的是 **Rabi Harness**；程式碼裡的引擎 id 是 `uac`，實作目錄與
> npm 套件仍叫 `unieai-agent-core`（`third_party/unieai-agent-core`）。三種寫法在
> 指令與設定檔裡都接受（`/engine rabi`、`unieai-code.engine = uac`）。

## 全景

```
┌─ 使用者介面 ────────────────────────────────────────────────┐
│  Rust TUI (`unieai`)   ·   VS Code 聊天面板   ·   exec (headless) │
└──────────┬──────────────────────┬───────────────────────────┘
           │                      │  面板可切換兩個引擎（unieai-code.engine）
           ▼                      ▼
┌─ 引擎 A: codex ────────┐   ┌─ 引擎 B: Rabi Harness (uac) ──────┐
│ Rust agent loop        │   │ unieai-agent-core（JS，submodule）│
│ · sandbox (seatbelt/   │   │ · 起 rabi（`--profile acp`）再疊    │
│   landlock)            │   │   本專案的 patch（config.mjs）     │
│ · 互動核准             │   │ · ACP 通訊（JSON-RPC over stdio）  │
│ · app-server (JSON-RPC)│   │ · 工具層 = rabi 的外掛＋本專案注入 │
│ · IDE 整合             │   │ · 審批、排程、goal、rewind 在身上  │
└──────────┬─────────────┘   └──────────┬────────────────────────┘
           │  Responses API             │  openai-completions（rabi 代送）
           ▼                            ▼
        UnieAI gateway  /v1/responses  →  Qwen / GLM / MiniMax …
```

## 兩個引擎，為什麼並存

| | codex（引擎 A） | Rabi Harness（引擎 B） |
|---|---|---|
| 語言 | Rust | JS（rabi 本體）＋ Rust app-server 轉接 |
| 執行安全 | 內建 sandbox + 互動核准 + execpolicy | rabi 自己的權限層，經 ACP 問 client；uac 決定誰回答（使用者或自動審查） |
| 防呆韌性 | 基本（HTTP/串流重試） | doom-loop 偵測、soft-landing、malformed 修復、idle-timeout、回合結束守門 |
| 周邊 | session、IDE 協定、review 模式 | 子代理、排程、goal、rewind／fork、artifacts |
| 共用者 | 本 repo | 本 repo **＋ UnieAI Studio** |

**收斂方向**：Rabi Harness 是「一套流程，各處注入工具」——Studio 注入 kb/sql/bi
（API 型工具，不需 sandbox），UnieAI Code 注入 shell/edit（sandbox 在工具內）。
面板與 `/engine uac` 已可切到共用引擎；預設就是它。

引擎 B 只有 `standard` 與 `minimal` 兩個模式。曾經存在的 `ptc`（一次呼叫跑多個工具）
與 `creator`（cordis 檢視）需要 rabi web app 才有的 `cordisInspect`，ACP 底下是空殼，
因此從選單移除；手寫在模式檔裡仍然有效，但不受支援。

## Provider 與模型

- 內建 `unieai` provider（`api.unieai.com/v1`，`wire_api = "responses"`），登入後
  設為預設。模型目錄來自 Studio `/api/config`（不是 gateway 的 `/v1/models`）。
- 開源模型不出現 codex 內建的 gpt 目錄；無模型時引導到 `<studio>/models`。

## 開源模型 harness（治「宣告後停止」）

codex 原版提示是 GPT 特調的 3 萬 tokens 長文，開源模型讀了容易「說要做卻停住」。
Fork 對 gateway 模型換上精簡提示（由 Rabi Harness 的 `buildSystemPrompt()` 生成，
存為 `gateway_instructions.md`），第一條規則是 **act-don't-announce**。另外：

- `tool_mode = Direct`（不切 code-mode）、不送 gateway 不認得的 reasoning 參數
- stream idle-timeout 75s（gateway 涓流 stall 自動重試）
- inline `<think>` 剝離：MiniMax/Qwen 把思考塞在 content 通道，剝離到 reasoning
  通道，避免漏進答案與歷史（GLM 走正規 reasoning 通道，本來就乾淨）

見 [benchmarks.md](benchmarks.md) 的 A/B 數據。

## 資料目錄

- 預設 `~/.unieai`（`UNIEAI_HOME` 覆蓋；`CODEX_HOME` 相容保留）
- 登入憑證 + 模型目錄：`~/.unieai/unieai.json`
- Rabi Harness session：`~/.unieai/agent-sessions/`；codex rollout：`~/.unieai/sessions/`
- 專案層設定（codex engine）：`<project>/.unieai/`（`config.toml`、`skills/`、
  `rules/`、`agents/`、hooks）。`.unieai/` 不存在時才讀舊的 `<project>/.codex/`
  （legacy 相容）；兩者並存時只讀 `.unieai/`，並在啟動時警告 `.codex/` 被忽略。
  `.agents/skills` 照常載入。沙箱預設將 `.unieai/`、`.codex/`、`.agents/`、`.git/`
  設為唯讀。常數：`codex_protocol::unieai_project_config_dir`
  （`codex_config::PROJECT_CONFIG_DIR_NAME` / `LEGACY_PROJECT_CONFIG_DIR_NAME`）。

## 發佈

- `.github/workflows/release-cli.yml`：`cli-v*` tag → macOS arm64/x64 +
  Linux musl x64/arm64 → 發到 `UnieAI/Unieai-Code-Publish`（`install.sh` 同步）
- 版本從 tag stamp 進 workspace Cargo.toml（不需每次改版 commit）
