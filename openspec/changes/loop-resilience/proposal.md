# Proposal: loop-resilience

**Target:** unieai-agent-core（session 持久化與失控防護）· 來源：opencode `session/message-updater.ts`、`session/projector.ts`、`runner/llm.ts`、`session/processor.ts`、`session/run-state.ts`

## Why

現行 session 只在**回合邊界**持久化（`engine.mjs` 於 `send()` 結束時 `saveSession`）：回合進行中程序死掉，該回合的所有進度（含執行到一半的工具）就遺失，也沒有「重啟後把殘留 pending 工具收乾淨」的復原。此外失控防護分散，缺少「連續相同工具呼叫」的斷路與「取消 session 連帶取消子任務」的級聯。opencode 用事件溯源把 session 做成事件級持久化、可崩潰復原、可重播，並有幾個小而有效的失控斷路。

## What Changes

- **事件溯源 session**：回合把 domain 事件（Text.Delta、Tool.Called/Success/Failed、Step.Ended、Compaction.*）寫成耐久紀錄，經一個純投影 reducer 折成訊息狀態；同一 reducer 同時餵**記憶體**與**SQLite** adapter，讓直播與持久化共用邏輯。
- **崩潰復原**：啟動時把上一輪殘留 pending/running 的工具標記為 failed（`failInterruptedTools`），使中斷的回合可重播而非卡死。
- **doom-loop 斷路**：連續 3 次相同工具呼叫（同名＋同輸入）→ 觸發權限提示，打斷無效迴圈。
- **子任務級聯取消**：取消一個 session 時，沿 `parentSessionId` 鏈 BFS 取消所有子孫背景任務。

## Capabilities

### New Capabilities
- `session-event-sourcing`：domain 事件、純投影 reducer、雙 adapter（RAM/SQL）、崩潰復原（中斷工具標 failed）。
- `loop-circuit-breakers`：連續相同工具呼叫斷路、session 取消的子任務級聯。

## Impact

- **落點：unieai-agent-core**：session 儲存改事件溯源（架構級，建議獨立分期）；斷路器可先行落地（小而獨立）。
- 與 checkpoint（`session-checkpoint-revert`）互補：一個管訊息狀態溯源，一個管檔案快照。
- 風險：事件溯源是大改，需與現行記憶體 session 相容遷移；建議先做斷路器與崩潰復原的最小版本，再上事件溯源。
