# Proposal: tui-rewind-diff

**Target:** unieai-code（TUI 前端）· 來源：grok-build `views/rewind.rs`、`views/jump.rs`；opencode `feature-plugins/system/diff-viewer.tsx`

## Why

`session-checkpoint-revert`（agent-core）提供三軸回捲與檔案快照的能力，但需要一個前端。grok 的 Esc-Esc 回捲 picker 與 `/jump` 導航、以及 opencode 的全螢幕 diff 檢視器，是把這個能力交到使用者手上的成熟 UI。

## What Changes

- **Esc-Esc 回捲 picker**：閒置且輸入框空時 Esc-Esc 開回捲 picker；每個回捲點顯示 prompt 預覽、檔案快照數、是否有檔案變更；套用後回報還原/衝突。三軸（只對話/只檔案/全回）以模式切換呈現。（接 agent-core 的 revert API。）
- **/jump 即時預覽導航**：列出每個回合，游標移動即時捲動 transcript 到該回合，Enter 定位、Esc 用寬度穩定的 anchor 還原原視窗。
- **全螢幕 diff 檢視器**：split/unified 切換、檔案樹、hunk 跳轉、標記已審閱、來源切換（工作區/main 分支/上一回合）。

## Capabilities

### New Capabilities
- `tui-rewind`：Esc-Esc 回捲 picker（三軸、預覽、衝突呈現）與 /jump 即時預覽導航。
- `tui-diff-viewer`：全螢幕 diff 檢視器（審閱狀態、來源切換）。

## Impact

- **落點：unieai-code**（codex-rs/tui）。`tui-rewind` 依賴 `session-checkpoint-revert` 的 revert API。
- 風險：回捲是破壞性操作，UI 必須清楚呈現「將還原哪些檔案」與衝突，套用前可預覽。
