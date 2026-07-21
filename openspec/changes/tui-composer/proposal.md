# Proposal: tui-composer

**Target:** unieai-code（codex-rs TUI 輸入）· 來源：grok-build `actions/`、`views/modal.rs`、`views/prompt_suggestion.rs`、`views/prompt_widget/`、`tips/`；opencode which-key `feature-plugins/system/which-key.tsx`

## Why

輸入區還可以更好操作：codex 有 slash 但沒有**統一命令面板**；沒有**下一句預測**、沒有**貼上/圖片 chip**、沒有情境**教學提示**、沒有 **which-key** 這種可探索的鍵位提示。這些都是低風險、高日常價值的輸入層升級。

## What Changes

- **統一命令面板（Ctrl+P）**：一個 ActionRegistry 同時餵快捷列、按鍵派發、模糊搜尋面板；選到需要參數的指令接一個 arg-picker（可退回面板）。
- **下一句 ghost 提示**：回合結束後預測下一句，灰字顯示在空輸入框；Tab/Right 接受，打字相符則縮短、發散則隱藏；可見與否每幀從當前文字推導（無狀態機）。
- **貼上/圖片 chip**：大段貼上折成可展開的 `[Pasted N lines]`、圖片折成 `[Image #N]` 可預覽——輸入框內帶 range、能跨 stash/restore 存活的原子元素。
- **TTL 教學提示**：輸入框上方一行提示，故意在打字時不消失（只靠 TTL/送出清除），每 session 看過 N 次就不再出現。
- **which-key 疊層**：顯示當前情境可達鍵位（分頁欄），配合 mode-stack 讓綁定隨情境切換。

## Capabilities

### New Capabilities
- `command-palette`：ActionRegistry 單一來源、模糊面板、arg-picker 鏈。
- `composer-assist`：ghost 下一句、貼上/圖片 chip、TTL 教學提示、which-key。

## Impact

- **落點：unieai-code**（codex-rs/tui）。命令面板需把既有 action 收斂到單一 registry（重構）；其餘為 additive。
- ghost 下一句需引擎「預測下一句」呼叫（可用小模型，接 provider-hardening 的小模型挑選）。
- 風險：registry 收斂的重構面；chip 需自訂 TextArea 元素模型（較重）。
