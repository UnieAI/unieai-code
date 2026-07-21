# Proposal: compaction-living-summary

**Target:** unieai-agent-core（純函式 library）＋ agent-runtime（有狀態 engine 接線）· 來源：opencode `packages/core/src/session/compaction.ts` + grok-build `xai-grok-shell/src/session/two_pass.rs`

## Why

現況（查證 `third_party/unieai-agent-core/src/compaction.mjs` 與 `loop.mjs:244-258`）：agent-core 的 compaction 是**純機械式 PRUNE→TRIM**——舊回合的工具輸出硬截到 400 字元、仍超預算就整段丟棄舊回合（切在 user 訊息邊界保住 tool 配對）。這是刻意設計：agent-core-1.0 是 **stateless API**，壓縮跑在請求關鍵路徑上，做 LLM 摘要呼叫會讓首個串流 token 停滯。另外 `loop.mjs` **已有**單次反應式溢出恢復（`overflowRecovered` 守衛：overflow → 強制 prune → 重發同一步）。

真正的缺口是：**沒有任何語意保留**。長對話裡，舊回合被硬截或整段丟掉，已確立的事實（路徑、符號、決策、錯誤字面）就此蒸發。opencode 的解法是維持**一份滾動的結構化摘要**（固定骨架），每次壓縮**合併進舊摘要**（保留仍為真、移除過時、併入新增）而非重摘，加一段逐字近況尾巴；grok-build 的 two-pass（先壓 95% → 再改寫）是長歷史的互補技巧。

**設計約束（本 change 的關鍵）**：LLM 摘要不能進 stateless 的請求關鍵路徑。但 CLI/VS Code 走的 `agent-runtime/src/engine.mjs` 是**有狀態的**（持有 messages、saveSession）。所以分層：摘要邏輯做成 agent-core 的**純函式 library**（不掛在關鍵路徑），由有狀態的 engine 在**回合之間**呼叫並存入 session；stateless 路徑的機械 PRUNE→TRIM 與回合中 overflow 恢復**原樣保留**，作為請求內的安全網。

## What Changes

- **滾動結構摘要（agent-core 純函式）**：`updateLivingSummary(prevSummary, olderMessages)` 產出固定骨架的 Markdown 摘要（Objective / Important Details / Work State{Completed,Active,Blocked} / Next Move / Relevant Files），下一次呼叫以「保留仍為真、刪除過時、合併新增」的指令**改寫上一份摘要**，而非從零重摘。摘要提示明令保留精確路徑／符號／指令／錯誤字串。
- **engine 層接線（agent-runtime）**：回合結束後（off critical path）由有狀態 engine 呼叫摘要函式，把「摘要 + 逐字近況尾巴」寫回 session；下一回合送出的歷史 = 系統提示 + 滾動摘要 + 逐字尾巴。摘要呼叫用小模型（接 `provider-hardening` 的小模型挑選）。
- **逐字近況尾巴**：摘要之外保留最近 `KEEP_TOKENS`（預設 8000）的逐字訊息；分割點允許在一則訊息中間切字以精準命中預算。
- **既有機械路徑保留**：stateless 的 PRUNE→TRIM 與 `loop.mjs` 既有的單次 overflow 恢復（機械 prune → 重發）原樣保留，作為請求內安全網——本 change 不動關鍵路徑。
- **two-pass 摘要**（採自 grok-build）：歷史很長時，先摘 ~95%（by token weight）成 NOTE₁，再以 NOTE₁ + 5% 尾巴改寫成後繼可見的 NOTE₂。作為滾動摘要的長歷史特例。
- **摘要輸入內的工具輸出截斷**：送進摘要器的工具輸出先截到 ~2k 字，避免摘要成本被單筆巨量輸出吃掉。

## Capabilities

### New Capabilities
- `context-compaction`：滾動結構摘要的內容契約（骨架欄位、合併語意）、逐字尾巴預算、two-pass 條件；並把既有請求內機械恢復（PRUNE→TRIM + 單次 overflow 重發）明文化為 spec。

### Modified Capabilities
（目前無既有 compaction spec；本 change 建立之。）

## Impact

- **落點分層**：unieai-agent-core（`src/compaction.mjs` 新增純函式滾動摘要 + two-pass；不掛關鍵路徑）＋ agent-runtime（`src/engine.mjs` 回合間呼叫、session 存摘要）。`loop.mjs` 既有 overflow 恢復（`loop.mjs:244-258`）與 stateless PRUNE→TRIM 不動。
- CLI/VS Code 透過既有 `createEngine` 自動受惠；agent-core-1.0 的 stateless API 消費者行為不變。
- 風險：滾動摘要的「合併」提示品質直接決定長對話不漂移，需要以既有 SWE-bench 軌跡回歸（壓縮後仍記得 issue 引用的字面）；摘要呼叫失敗必須 fail-open（下一回合退回機械路徑），不得阻塞回合。
- 依賴：`provider-hardening` 的小模型挑選（摘要呼叫用便宜模型；先行時可暫用主模型）。
