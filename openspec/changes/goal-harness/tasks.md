# Tasks: goal-harness

## 1. 研究對照
- [ ] 1.1 讀 grok `goal_planner.rs`（fail-closed、plan.md）、`goal_strategist.rs:1-20`（PlanGuard）、`goal_summarizer.rs`、`goal_tracker.rs`（gap 指紋停滯）
- [ ] 1.2 讀 `turn.rs:778-825` + `stop_gate.rs:9`（兩層續跑、cap 8）
- [ ] 1.3 讀 `laziness_classifier.rs:6-30`（idle 觸發、30 訊息窗、三層）
- [x] 1.4 對照現行 agent-core `workspaceCompletionCheck`：單一 skeptic + mutation gate + 決定論閘門，`completionCheckMax:3`，skeptic 每回合一次（closure latch）。gap 停滯需跨回合狀態（engine 層）

## 2. verifier（保留既有）
- [x] 2.1 現行 skeptic + 缺口重播即 verifier 角色（保留未動）

## 3. planner（fail-closed）
- [x] 3.1（輕量版）engine 層 in-session 任務 checklist：`agent-runtime/src/goal-plan.mjs`（`parsePlan` 支援 JSON array／markdown checkbox，`openSteps`／`reconcilePlan`（保守 token 覆蓋率打勾，只會少打不會誤打）／`planNudgeBlock`（「plan item still open: …」）／`buildPlanRequest`）。engine `runTurn` 每個 mutation session 以一次小 aux-model call fire-and-forget 產出 plan（off hot path），存於 `goalState.plan` 並比照 `rollingSummary`/`contextEpoch` 持久化（`session.mjs` 加 `plan` 欄位）；verifier NotAchieved 時 append 未完成項目。**fail-closed = plan 解析失敗即 `goalState.plan` 留 null、跳過 planning，不中斷 turn**。14 tests。**未做**完整 plan.md 契約檔 + 失敗 PAUSE goal（需 planner subagent spawn，較重）

> DEFERRED（跨 §3/§4/§5.1-5.2/§6/§7）：完整多角色 subagent 樂團（planner/strategist/summarizer 各自為獨立 subagent）＋ 可還原 guard 的 plan.md 契約檔＋ planner 失敗 PAUSE goal＋ 兩層續跑閘門，全部需要 agent-core 的 subagent spawn 機制，本輪不做。已落地的是 agent-runtime 層的輕量等價物（in-session plan checklist、fire-and-forget summarizer、gap 指紋停滯早退、strategist 升級 nudge），皆為 fail-open/fail-closed 純函式 + engine wiring，未觸及 agent-core 既有共享行為（Studio-safe）。

## 4. strategist（fail-open）+ summarizer（once）
- [x] 4.1 連續 N 次 NotAchieved 觸發 strategist **升級 nudge**（輕量版）：`agent-runtime/src/completion-escalation.mjs` `buildNudge`（`STRATEGIST_THRESHOLD=3`；達門檻改「停止小修、重新思考整體 approach」訊息）；engine `goalState.consecutiveNotAchieved` 跨回合、ACHIEVED 重置。5 tests。**未做**完整 strategist subagent + PlanGuard/plan.md（需 subagent spawn，較重）
- [x] 4.2（輕量版）ACHIEVED 時 summarizer 跑一次寫結案摘要：`agent-runtime/src/goal-summarizer.mjs`（`changedFilesFromStatus`／`buildSummaryRequest`（80 字、4 bullet 上限）／`clampSummary`（1200 char 上限 + marker））。engine verifier 判定 ACHIEVED 時以 `goalState.summaryFired` latch 觸發一次小 aux-model call，**fire-and-forget 不 await**、經 `onSummary` callback 浮現、fail-open（LLM 完全在 hot path 外，不阻塞完成判定）。8 tests。**未做**完整 read-only summarizer subagent（需 subagent spawn）

## 5. 兩層續跑 + 停滯早退
- [ ] 5.1 goal round-end 續跑決策
- [ ] 5.2 stop-hook gate（cap 8/回合）
- [x] 5.3 gap 指紋停滯早退（連兩次相同 → 停止 nudge）— `agent-core/src/gap-fingerprint.mjs`（`fingerprintGaps` 對排序/行號/code span 不敏感 + `isRepeatedStall`；7 tests）；engine `goalState.lastGapFingerprint` 跨回合，skeptic 回相同 gap → return null 不再 nudge

## 6. laziness 精修
- [ ] 6.1 補 idle 觸發（10s）、30 訊息窗、三層定位

## 7. 驗收
- [ ] 7.1 整合：planner 失敗 → PAUSE；strategist 出手不汙染 plan.md
- [ ] 7.2 整合：重複 gap → 停滯早退
- [ ] 7.3 回歸：SWE-bench 抽樣「宣稱完成但沒做對」失分是否下降
- [ ] 7.4 openspec validate + archive
