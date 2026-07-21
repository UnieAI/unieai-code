# Tasks: loop-resilience

> 進度註記（2026-07-22）：查證後，本 change 的兩個「小而獨立」部分（doom 斷路、
> 崩潰復原）**現行 agent-core 已具備等價機制**，不重做；剩餘（子任務級聯取消、
> 事件溯源）需先有 subagent 父子鏈與架構級 session 改寫，皆為 Studio 共用庫的重型
> 變更，明確**獨立分期延後**（避免動到共用 agent-core 的 session 儲存語意）。

## 1. 研究對照
- [x] 1.1 對照 opencode failInterruptedTools ↔ 現行 agent-core `loop.mjs:96-131`
  訊息修復：對「有 tool_call 卻無對應 result」的中斷回合，合成 placeholder result
  （「session was interrupted; re-run the tool if its output is still needed」），
  並丟棄孤兒/重複 result，使中斷的回合可重播而非卡死——即 §3.1 的等價落地。
- [x] 1.2 對照 doom-loop ↔ `loop.mjs` identical-args guard + layer-2 streak（見 §2.1）。
  級聯取消需 `parentSessionId` 子任務鏈（agent-core 現無 subagent 樹）→ 隨 subagent 能力再做。

## 2. 斷路器
- [~] 2.1 連續相同工具呼叫斷路 — **已存在**：loop.mjs 已有 identical-args guard（相同工具+相同參數，doom layer-1）+ layer-2 streak（doomStreakWarn/Force，host-tunable）。opencode 的「3 次相同→提示」已被涵蓋，不重做；若要「升成權限提示而非自動 wrap-up」再評估
- [ ] 2.2 session 取消 → 沿 parentSessionId BFS 級聯（agent-core 是否有 subagent 父子鏈待查；若無則隨 subagent 能力一起做）

## 3. 崩潰復原（最小版本）
- [x] 3.1 中斷回合的殘留 tool_call 收乾淨 — **已存在**：`loop.mjs:96-131` 在載入/重播時
  對無 result 的 tool_call 合成 interrupted placeholder（等價 failInterruptedTools），
  使回合可續而非卡死。比 opencode 更前置（每次組 wire 訊息即修復，非僅啟動時）。
  差異：現行合成的是「interrupted，可重跑」而非硬標 failed 狀態機——對無 SQLite 事件流的
  記憶體 session 更貼切。真正「pending/running 狀態機」需 §4 事件溯源，隨之延後。

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
