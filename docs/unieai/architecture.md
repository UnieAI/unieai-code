# 架構

UnieAI Code 把 OpenAI codex（Rust harness）接上 UnieAI 平台，並逐步把 agent
迴圈收斂到與 UnieAI Studio 共用的 `unieai-agent-core`。

## 全景

```
┌─ 使用者介面 ────────────────────────────────────────────────┐
│  Rust TUI (`unieai`)   ·   VS Code 聊天面板   ·   exec (headless) │
└──────────┬──────────────────────┬───────────────────────────┘
           │                      │  面板可切換兩個引擎（unieai-code.engine）
           ▼                      ▼
┌─ 引擎 A: codex ────────┐   ┌─ 引擎 B: agent-core ──────────────┐
│ Rust agent loop        │   │ unieai-agent-core（JS，submodule）│
│ · sandbox (seatbelt/   │   │ · 純流程迴圈，與 Studio 共用       │
│   landlock)            │   │ · doom-loop guard、soft-landing、  │
│ · 互動核准             │   │   malformed 修復、compaction       │
│ · app-server (JSON-RPC)│   │ · sandbox/核准 = 工具的事（注入）  │
│ · IDE 整合             │   │ · <think> 剝離、stream idle-timeout│
└──────────┬─────────────┘   └──────────┬────────────────────────┘
           │  Responses API             │  Responses API (wireApi)
           ▼                            ▼
        UnieAI gateway  /v1/responses  →  Qwen / GLM / MiniMax …
```

## 兩個引擎，為什麼並存

| | codex（引擎 A） | agent-core（引擎 B） |
|---|---|---|
| 語言 | Rust | JS |
| 執行安全 | 內建 sandbox + 互動核准 + execpolicy | sandbox/核准由**工具層**負責（`bash` 包 `unieai sandbox`，被拒才走核准縫） |
| 防呆韌性 | 基本（HTTP/串流重試） | doom-loop 偵測、soft-landing、malformed 修復、idle-timeout |
| 周邊 | session、IDE 協定、review 模式 | 輕量嵌入式函式庫 |
| 共用者 | 本 repo | 本 repo **＋ UnieAI Studio** |

**收斂方向**：agent-core 是「一套流程，各處注入工具」——Studio 注入 kb/sql/bi
（API 型工具，不需 sandbox），UnieAI Code 注入 shell/edit（sandbox 在工具內）。
面板已可用 `unieai-code.engine = agent-core` 切到共用引擎；TUI 過渡期仍用 codex。

## Provider 與模型

- 內建 `unieai` provider（`api.unieai.com/v1`，`wire_api = "responses"`），登入後
  設為預設。模型目錄來自 Studio `/api/config`（不是 gateway 的 `/v1/models`）。
- 開源模型不出現 codex 內建的 gpt 目錄；無模型時引導到 `<studio>/models`。

## 開源模型 harness（治「宣告後停止」）

codex 原版提示是 GPT 特調的 3 萬 tokens 長文，開源模型讀了容易「說要做卻停住」。
Fork 對 gateway 模型換上精簡提示（由 agent-core 的 `buildSystemPrompt()` 生成，
存為 `gateway_instructions.md`），第一條規則是 **act-don't-announce**。另外：

- `tool_mode = Direct`（不切 code-mode）、不送 gateway 不認得的 reasoning 參數
- stream idle-timeout 75s（gateway 涓流 stall 自動重試）
- inline `<think>` 剝離：MiniMax/Qwen 把思考塞在 content 通道，剝離到 reasoning
  通道，避免漏進答案與歷史（GLM 走正規 reasoning 通道，本來就乾淨）

見 [benchmarks.md](benchmarks.md) 的 A/B 數據。

## 資料目錄

- 預設 `~/.unieai`（`UNIEAI_HOME` 覆蓋；`CODEX_HOME` 相容保留）
- 登入憑證 + 模型目錄：`~/.unieai/unieai.json`
- agent-core session：`~/.unieai/agent-sessions/`；codex rollout：`~/.unieai/sessions/`

## 發佈

- `.github/workflows/release-cli.yml`：`cli-v*` tag → macOS arm64/x64 +
  Linux musl x64/arm64 → 發到 `UnieAI/Unieai-Code-Publish`（`install.sh` 同步）
- 版本從 tag stamp 進 workspace Cargo.toml（不需每次改版 commit）
