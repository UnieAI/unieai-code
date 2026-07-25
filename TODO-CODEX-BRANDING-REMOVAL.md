# Codex 品牌移除 TODO

> 目標：讓 TUI、CLI 及所有用戶可見的輸出中不再出現 "codex" 字眼，統一為 "unieai" 品牌。

---

## 1. Binary 名稱與 CLI 入口

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 1.1 | `codex-rs/cli/Cargo.toml` | 2, 6 | `[[bin]] name = "codex"` → `"unieai"`；`name = "codex-cli"` → `"unieai-cli"` |
| 1.2 | `codex-rs/cli/src/main.rs` | 2513 | `let name = "codex";` → `let name = "unieai";` |
| 1.3 | `codex-rs/cli/src/main.rs` | 126-145 | 所有 `/// Run Codex…`、`/// Manage Codex…` 等 doc comment 改為 `UnieAI` |
| 1.4 | `codex-rs/cli/src/main.rs` | 164 | `/// Diagnose local Codex…` → `UnieAI` |
| 1.5 | `codex-rs/cli/src/main.rs` | 167 | `/// Run commands within a Codex-provided sandbox` → `UnieAI` |
| 1.6 | `codex-rs/cli/src/main.rs` | 196 | `/// [EXPERIMENTAL] Browse tasks from Codex Cloud` → `UnieAI` |
| 1.7 | `codex-rs/cli/src/main.rs` | 286/296/356/533/578 | `fields that are not recognized by this version of Codex` → `UnieAI` |
| 1.8 | `codex-rs/cli/src/main.rs` | 773 | `Updating Codex via` → `Updating UnieAI via` |
| 1.9 | `codex-rs/cli/src/main.rs` | 808 | `restart Codex` → `restart UnieAI` |
| 1.10 | `codex-rs/cli/src/main.rs` | 816 | ``codex update`` → `unieai update` |
| 1.11 | `codex-rs/cli/src/main.rs` | 824 | `https://developers.openai.com/codex/cli/` → 更新為 UnieAI 網址 |
| 1.12 | `codex-rs/cli/src/main.rs` | 1130 | `/// Print local CLI and running app-server versions as JSON` (無 codex，保留) |

---

## 2. TUI 品牌

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 2.1 | `codex-rs/tui/src/chatwidget/tool_requests.rs` | 188-241 | `"codex could call MCP tool"` → `"UnieAI could call MCP tool"`；`"codex to access"` → `"UnieAI to access"` |
| 2.2 | `codex-rs/tui/src/frames.rs` | 48 | `FRAMES_CODEX` 常數 — 考慮改為 `FRAMES_UNIEAI`，並更換 spritesheet 檔名 |
| 2.3 | `codex-rs/tui/src/pets/mod.rs` | 50 | `DEFAULT_PET_ID: &str = "codex"` → `"unieai"` |
| 2.4 | `codex-rs/tui/src/pets/catalog.rs` | 20/23 | `id: "codex"` → `"unieai"`；`spritesheet_file: "codex-spritesheet-v4.webp"` → `"unieai-spritesheet-v4.webp"` |
| 2.5 | `codex-rs/tui/src/update_action.rs` | 47 | `("brew", &["upgrade", "--cask", "codex"])` → `"unieai"` |
| 2.6 | `codex-rs/tui/src/update_action.rs` | 132/143 | `"codex-resources"` → `"unieai-resources"` |
| 2.7 | `codex-rs/tui/src/lib.rs` | 251 | `TUI_LOG_FILE_NAME: &str = "codex-tui.log"` → `"unieai-tui.log"` |
| 2.8 | `codex-rs/tui/src/clipboard_paste.rs` | 127 | `.prefix("codex-clipboard-")` → `"unieai-clipboard-"` |
| 2.9 | `codex-rs/tui/src/ide_context/ipc.rs` | 23 | `TUI_SOURCE_CLIENT_ID: &str = "codex-tui"` → `"unieai-tui"` |

---

## 3. 內部服務/事件/指標名稱（後端但可被用戶看到）

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 3.1 | `codex-rs/tui/src/app.rs` | 870 | `counter("codex.status_line", ...)` → `"unieai.status_line"` |
| 3.2 | `codex-rs/tui/src/app.rs` | 975 | `"codex.thread.fork"` → `"unieai.thread.fork"` |
| 3.3 | `codex-rs/tui/src/app/side.rs` | 569 | `"codex.thread.side"` → `"unieai.thread.side"` |
| 3.4 | `codex-rs/tui/src/app/event_dispatch.rs` | 169/247 | `"codex.thread.fork"` → `"unieai.thread.fork"` |
| 3.5 | `codex-rs/tui/src/app/event_dispatch.rs` | 1228-1506 | `codex.windows_sandbox.*` → `unieai.windows_sandbox.*` |
| 3.6 | `codex-rs/tui/src/chatwidget/status_controls.rs` | 324 | `"codex"` limit key → `"unieai"` |
| 3.7 | `codex-rs/tui/src/chatwidget/status_surfaces.rs` | 705/713/767/808 | `"codex"` limit key / app name → `"unieai"` |
| 3.8 | `codex-rs/tui/src/chatwidget/model_popups.rs` | 177-184 | `"codex-auto-"` 字串匹配 → `"unieai-auto-"` |
| 3.9 | `codex-rs/tui/src/chatwidget/settings.rs` | 712 | `model.starts_with("codex-auto-")` → `"unieai-auto-"` |
| 3.10 | `codex-rs/tui/src/chatwidget/windows_sandbox_prompts.rs` | 228-424 | `codex.windows_sandbox.*` → `unieai.windows_sandbox.*` |
| 3.11 | `codex-rs/tui/src/status/rate_limits.rs` | 141 | `limit_name: "codex"` → `"unieai"` |
| 3.12 | `codex-rs/tui/src/lib.rs` | 425/589 | `client_name: "codex-tui"` → `"unieai-tui"` |
| 3.13 | `codex-rs/tui/src/windows_sandbox.rs` | 86/88 | `codex.windows_sandbox.*` → `unieai.windows_sandbox.*` |
| 3.14 | `codex-rs/tui/src/app/config_persistence.rs` | 760 | `"codex-auto-"` → `"unieai-auto-"` |

---

## 4. Core 事件名稱（可透過日誌/調試面板被用戶看到）

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 4.1 | `codex-rs/core/src/skills.rs` | 105 | `"codex.skill.injected"` → `"unieai.skill.injected"` |
| 4.2 | `codex-rs/core/src/realtime_conversation.rs` | 96 | `STANDALONE_HANDOFF_ID: &str = "codex"` → `"unieai"` |
| 4.3 | `codex-rs/core/src/mcp_openai_file.rs` | 273/379/455/470 | `"use_case": "codex"` → `"use_case": "unieai"` |
| 4.4 | `codex-rs/core/src/agent_communication.rs` | 53/73 | `"codex.agent_communication"` → `"unieai.agent_communication"` |
| 4.5 | `codex-rs/core/src/tools/code_mode/mod.rs` | 434 | `"codex-code-mode-host-does-not-exist"` → `"unieai-code-mode-host-does-not-exist"` |
| 4.6 | `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs` | 150 | `"codex.multi_agent.spawn"` → `"unieai.multi_agent.spawn"` |
| 4.7 | `codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs` | 149 | `counter("codex.multi_agent.resume", ...)` → `"unieai.multi_agent.resume"` |
| 4.8 | `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs` | 150 | `"codex.multi_agent.spawn"` → `"unieai.multi_agent.spawn"` |
| 4.9 | `codex-rs/core/src/tools/parallel.rs` | 313/470 | `"codex.tool_call"` → `"unieai.tool_call"` |
| 4.10 | `codex-rs/core/src/tools/runtimes/mod_tests.rs` | 1038 | `"codex-resources"` → `"unieai-resources"` |
| 4.11 | `codex-rs/core/src/tools/sandboxing.rs` | 101 | `"codex.approval.requested"` → `"unieai.approval.requested"` |
| 4.12 | `codex-rs/core/src/client.rs` | 520 | `"codex.transport.fallback_to_http"` → `"unieai.transport.fallback_to_http"` |
| 4.13 | `codex-rs/core/src/compact_model_fallback.rs` | 46 | `"codex.compaction.model_fallback"` → `"unieai.compaction.model_fallback"` |
| 4.14 | `codex-rs/core/src/session/handlers.rs` | 637 | `"codex.conversation.turn.count"` → `"unieai.conversation.turn.count"` |
| 4.15 | `codex-rs/core/src/agent/registry.rs` | 210 | `"codex.multi_agent.nickname_pool_reset"` → `"unieai.multi_agent.nickname_pool_reset"` |
| 4.16 | `codex-rs/core/src/mcp_tool_call/telemetry.rs` | 10-12 | `"codex.mcp.call"`, `"codex.mcp.call.duration_ms"`, `"codex.mcp.call.error"` → `"unieai.mcp.*"` |
| 4.17 | `codex-rs/core/src/state/session.rs` | 320/326 | `"codex"` 預設 bucket → `"unieai"` |

---

## 5. install-context（安裝路徑/目錄名）

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 5.1 | `codex-rs/install-context/src/lib.rs` | 9 | `PACKAGE_METADATA_FILENAME: &str = "codex-package.json"` → `"unieai-package.json"` |
| 5.2 | `codex-rs/install-context/src/lib.rs` | 10 | `PATH_DIRNAME: &str = "codex-path"` → `"unieai-path"` |
| 5.3 | `codex-rs/install-context/src/lib.rs` | 12 | `RESOURCES_DIRNAME: &str = "codex-resources"` → `"unieai-resources"` |

> ⚠️ 這些是系統路徑常量，修改後會與既有安裝不兼容，需要考慮遷移策略或僅在全新安裝生效。

---

## 6. CLI 內部指令參考字串（測試用但也在 help 輸出中）

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 6.1 | `codex-rs/cli/src/main.rs` | 2513 | `let name = "codex";` → `"unieai"`（這是 `--help` 顯示的 binary name） |

> 所有 test 中的 `["codex", ...]` 陣列可以保留不改（test 用），或統一改為 `["unieai", ...]`。

---

## 7. 其他需要注意的檔案（不直接用戶可見，但建議一併檢查）

| # | 檔案 | 說明 |
|---|------|------|
| 7.1 | `codex-rs/cli/src/remote_control_cmd.rs` | `managed_codex_path`/`managed_codex_version` 變數名（內部用，可保留）；prefix `"codex-rc-"` → `"unieai-rc-"` |
| 7.2 | `codex-rs/cli/src/sandbox_setup.rs` | `--codex-home` flag（可考慮改為 `--unieai-home`） |
| 7.3 | `codex-rs/cli/src/doctor/background.rs` | `"codex plugins are disabled"` → `"UnieAI plugins are disabled"` |
| 7.4 | `codex-rs/cli/src/plugin_cmd.rs` | `allowed_configured_marketplace_names` 中的 codex_home（內部用） |
| 7.5 | `codex-rs/cli/src/exec_server_telemetry.rs` | `OTEL_SERVICE_NAME = "codex-exec-server"` → `"unieai-exec-server"` |
| 7.6 | `codex-rs/app-server-protocol/src/export.rs` | 輸出檔案名 `codex_app_server_protocol.*` → `unieai_app_server_protocol.*` |
| 7.7 | `codex-rs/mcp-server/`、`codex-rs/stdout-to-uds/` 等 | 檢查是否也有 `codex-` 前綴的 binary 或 flag |

---

## 執行順序建議

1. **優先（用戶可見）**：
   - Binary 名稱 (Cargo.toml + main.rs name)
   - CLI help text 中的 "Codex" 文案
   - TUI 中的 "codex could…" 字串
   - TUI pet/spritesheet 名稱

2. **次要（內建但可透過調試看到）**：
   - 事件名稱 (`codex.*` → `unieai.*`)
   - telemetry / 指標名稱
   - app name 顯示（terminal title）

3. **最後（系統路徑/兼容性）**：
   - install-context 路徑常量（需遷移策略）
   - `--codex-home` flag 改名

---

## 補充檢查

在修改前，請再跑一次全域搜尋確認沒有遺漏：

```bash
# 用戶可見的字串
cd codex-rs && rg --no-heading --line-number '(\"codex|Codex|\"Codex)' --type rust | grep -iv 'mod \|#\[cfg\|#\[test\|test_\|codex_home\|find_codex_home\|CODEX_'
```

---

## 8. codex-cli/ (Node.js 包裝器)

| # | 檔案 | 行號 | 修改內容 |
|---|------|------|----------|
| 8.1 | `codex-cli/bin/codex.js` | 1 | 註解 `// Unified entry point for the Codex CLI.` → `UnieAI CLI` |
| 8.2 | `codex-cli/bin/codex.js` | 80-85 | 變數名 `codexPackageRoot`、`findCodexExecutable`、`codexExecutable` 改為 `unieai` |
| 8.3 | `codex-cli/bin/codex.js` | 80-85 | `Missing optional dependency... Reinstall Codex:` → `UnieAI` |
| 8.4 | `codex-cli/bin/codex.js` | 93-110 | `isPnpmOwnedCodexInstall` → `isPnpmOwnedUnieaiInstall` |
| 8.5 | `codex-cli/bin/codex.js` | 128-130 | 環境變數 `CODEX_MANAGED_BY_*` → `UNIEAI_MANAGED_BY_*` |
| 8.6 | `codex-cli/package.json` | 5 | `"name": "@unieai/code"` 和 `"bin": { "unieai": "bin/codex.js" }` — 檔名 `bin/codex.js` → `bin/unieai.js`（或可保留，因 npm bin name 已經是 `unieai`） |

> ⚠️ `codex-cli/package.json` 的 npm package 已經是 `@unieai/code`，bin 已經是 `unieai`。這個 wrapper 主要是把 "codex" 字串從 error messages / comments / 變數名 中移除。

---

## 9. 需要檢查但尚未盤點的其他目錄

| # | 目錄/檔案 | 需要做的事 |
|---|-----------|-----------|
| 9.1 | `codex-rs/mcp-server/` | 檢查 binary name、help text |
| 9.2 | `codex-rs/stdio-to-uds/` | 同上 |
| 9.3 | `codex-rs/install-context/` | 第 5 節路徑常量（需遷移策略） |
| 9.4 | 所有 `*.snap` 快照檔案 | `cargo insta accept` 時檢查是否有 "codex" 字樣 |
| 9.5 | `docs/` 目錄 | 確認文件沒有對外暴露 "OpenAI Codex" 字樣 |
| 9.6 | `scripts/` 目錄 | build/install 腳本中的品牌字串 |
| 9.7 | `patches/` 目錄 | 檢查 patch 檔案中的 codex 參考 |
| 9.8 | `.github/` CI workflows | 檢查輸出/變數中的品牌字串 |

---

## 執行後確認腳本

```bash
# 全域搜尋確認是否還有用戶可見的 "codex"（排除 test、內部變數名、config 名稱）
cd codex-rs && rg --no-heading --line-number '(\"codex|\"Codex)' --type rust | \
  grep -iv 'mod \|#\[cfg\|#\[test\|test_\|codex_home\|find_codex_home\|CODEX_\|#\[path' | \
  grep -iv 'fn \|let \|use codex_\|#\[derive'

# 檢查 JS wrapper
rg --no-heading --line-number 'codex|Codex' codex-cli/ --type js

# 檢查 snapshot
rg --no-heading --line-number 'codex' codex-rs/tui/src/snapshots/ | head -20
```
