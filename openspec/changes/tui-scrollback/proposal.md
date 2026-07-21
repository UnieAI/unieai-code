# Proposal: tui-scrollback

**Target:** unieai-code（codex-rs TUI 渲染）· 來源：grok-build `scrollback/state/verb_group.rs`、`scrollback/sticky.rs`、`blocks/tool/edit.rs`、`blocks/tool/read.rs`

## Why

現行 codex TUI 一個工具呼叫一張卡，長活動會刷成一大片；標頭滾走後看不出「這段在做什麼」。grok 的 scrollback 有幾個明顯更好的呈現：把連續唯讀工具活動**折成一行會變時態的摘要**、prompt 當**釘頂標頭**、diff **漸進語法上色**、read 顯示**首尾預覽與內嵌媒體**。

## What Changes

- **動詞群組聚合**：連續的非破壞性工具呼叫折成一行摘要，依工具種類分桶、名詞複數化、進行中/完成切換時態（「Reading 1 file, Searching…」→「Read 3 files, Searched 2 patterns」），失敗附「· N failed」；WebSearch 依 citation URL 去重、subagent 依 child-session-id 去重。
- **sticky 回合標頭**：prompt 當節標頭，滾過去釘頂、下一個 prompt 逼近時被推走（純 1D 座標數學，可單元測試）。
- **diff 漸進語法上色**：先每 hunk 快速上色，背景 worker 升級成全檔 scope（多行 scope 才正確），2MiB/50k 行上限。
- **read 首尾預覽 + 內嵌媒體**：read 顯示首 5/末 3 行，圖片/PDF 可內嵌。

## Capabilities

### New Capabilities
- `scrollback-aggregation`：動詞群組時態聚合與去重規則。
- `scrollback-sticky`：釘頂回合標頭的佈局語意。
- `tool-card-rendering`：diff 漸進上色、read 首尾預覽與媒體。

## Impact

- **落點：unieai-code**（codex-rs/tui）。多為 additive 的呈現層改動。
- 風險：sticky 與現有 scrollback 佈局整合；漸進上色的背景 worker 需有上限避免大檔卡頓（已含 2MiB/50k 行 cap）。
