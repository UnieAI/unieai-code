# Proposal: harness-open-models

## Why

codex 的 harness 是為 GPT 系模型調校的：巨型 base instructions（單回合 prompt 常態 30k+ tokens）、apply_patch 自訂文法、OpenAI 專屬參數。Gateway 上的開源模型（Qwen/GLM/MiniMax…）沒受過這套訓練，表現為工具呼叫格式錯誤、無效迴圈、長時間停滯。OpenCode 與 Grok Build 已驗證解法：**對開源模型給它熟悉的工具方言與精簡提示**（Grok Build 同時內建 Codex 版與 OpenCode 版兩套工具並依模型切換）。

## What Changes

- **工具方言（tool dialect）**：模型目錄新增 per-model dialect 欄位。`opencode` 方言提供 OpenCode 風格工具集——`edit`（search/replace 函式，取代 apply_patch 文法）、`write`、`read`、`bash`、`todowrite`——以標準 function calling 暴露
- **精簡 base instructions**：開源模型用短版系統提示（OpenCode 量級，數百 tokens），敘述工具用法與安全守則；GPT 系模型維持原版
- **格式錯誤復原**：工具呼叫解析失敗時，以糾正訊息回饋模型重試（上限 N 次），而非停滯等 idle timeout
- Dialect 由 Studio 模型設定下發（`unieai.json` 帶 per-model dialect），CLI 預設 `opencode` 方言給所有 gateway 模型，config 可覆寫
- 已先行落地的快修（本提案的前置，不在此 change 內）：串流 idle timeout 300s→75s、tool_mode 固定 Direct、不送 reasoning-summary 參數

## Capabilities

### New Capabilities
- `tool-dialects`：per-model 工具集選擇、OpenCode 方言工具的行為定義（edit/write/read/bash/todowrite 的語意與安全邊界）
- `open-model-prompting`：精簡 instructions 的內容契約與掛載條件
- `malformed-call-recovery`：解析失敗的回饋迴圈與上限

### Modified Capabilities
（無既有 spec）

## Impact

- `codex-rs/core/src/tools/`（新工具實作與註冊）、`models-manager`（dialect 欄位）、`login/unieai.rs` + core config（dialect 下發）
- 是 fork 對 upstream 最大的一次分歧——工具層要設計成 **additive**（新增 dialect 模組，不改既有工具），把 rebase 衝突面壓到最小
- 風險：edit 工具的 search/replace 語意要與 sandbox/核准整合；需要以 2-3 個 gateway 模型做 A/B 驗證（成功率、平均回合數）
