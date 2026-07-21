# Tasks: loop-resilience

## 1. 研究對照
- [ ] 1.1 讀 opencode `message-updater.ts:78-395`、`projector.ts:331-395`（reducer）、`runner/llm.ts:119-139`（failInterruptedTools）
- [ ] 1.2 讀 `session/processor.ts:29,356-379`（doom-loop）、`run-state.ts:111-143`（級聯取消）

## 2. 斷路器
- [~] 2.1 連續相同工具呼叫斷路 — **已存在**：loop.mjs 已有 identical-args guard（相同工具+相同參數，doom layer-1）+ layer-2 streak（doomStreakWarn/Force，host-tunable）。opencode 的「3 次相同→提示」已被涵蓋，不重做；若要「升成權限提示而非自動 wrap-up」再評估
- [ ] 2.2 session 取消 → 沿 parentSessionId BFS 級聯（agent-core 是否有 subagent 父子鏈待查；若無則隨 subagent 能力一起做）

## 3. 崩潰復原（最小版本）
- [ ] 3.1 啟動時把殘留 pending/running 工具標 failed

## 4. 事件溯源（架構級，獨立分期）
- [ ] 4.1 domain 事件定義（Text/Tool/Step/Compaction）
- [ ] 4.2 純投影 reducer
- [ ] 4.3 RAM adapter + SQLite adapter 共用 reducer
- [ ] 4.4 與現行記憶體 session 的相容遷移

## 5. 驗收
- [ ] 5.1 整合：三次相同呼叫 → 斷路
- [ ] 5.2 整合：取消含子任務 session → 全級聯取消
- [ ] 5.3 整合：程序中途死 → 重啟工具標 failed 可續
- [ ] 5.4 openspec validate + archive
