# Tasks: turn-steering

## 1. 研究對照
- [ ] 1.1 讀 opencode `session/run-coordinator.ts:24-104`（single-flight/wake/interrupt/接續 drain）
- [ ] 1.2 讀 `session/input.ts` + `runner/llm.ts:190-196`（steer 重設步數為 1）與 queue drain
- [ ] 1.3 讀 `runner/max-steps.ts` + `runner/llm.ts:202-213`（卸工具 + toolChoice none + 強制摘要）
- [ ] 1.4 讀 `question.ts` + `tool/question.ts`（提問原語、不儲存、略過即止）

## 2. 單流協調器 — 完成（落在 agent-runtime 而非 agent-core）
> 落點修正：coordinator 是「engine 如何處理並發 send」的 consumer 側邏輯，放 `agent-runtime/src/turn-coordinator.mjs` 讓 agent-core 保持精簡、也不增加 Studio 面。
- [x] 2.1 per-session key 序列化（同 key 串行、不同 key 併行）；engine `send()` 包進 `turnCoordinator.run(sessionId, …)`，新增 `engine.isBusy()`
- [x] 2.2 `run()` 串接；`queueNext()` 合併單一後續（後到取代未 drain 的）；失敗的回合不 wedge queue
- [x] 2.3 成功且有 queued follow-up → afterDrain 以全新 chain 接續（修過 self-deadlock）。turn-coordinator.test.mjs 5 tests

## 3. steer / queue — 完成
- [x] 3.2 queue：`queueNext` 合併後續，回合結束自動 drain（已於 §2）
- [x] 3.1 steer：loop.mjs 加 **opt-in `ctx.drainSteer()` seam**（step 迴圈頂端 drain，注入為 user 訊息 + 發 steer 事件；無 drainSteer 就 no-op，Studio 安全）；engine 加 steerQueue + `drainSteer` + `engine.steer(text)`（回合中折入、閒置時下次 send 交付）。**未採「step budget 重設為 1」**（會提早結束回合；coding maxSteps=96 有充足空間讓 steer 被處理）。loop-steer.test.mjs 3 tests（注入+事件、no-op seam、throw 不破壞）
- [x] 3.3 與 completionCheck/goal 互動：steer 只是多一則 user 訊息，既有 completion 契約自然涵蓋（未改 gate）

## 4. 優雅 max-steps 降級 — 已存在（查證後）
- [x] 4.1 per-agent 步數上限（`ctx.maxSteps`，engine 設 96；無全域硬上限）— 已有
- [~] 4.2 最後一步強制摘要 — **已存在**：loop.mjs:26-34,209-237 已有「soft landing」grace step（最終步保留工具但注入「tool budget exhausted, provide final text summary now」）。與 opencode 的差別僅「卸工具 vs 保留工具」，行為等價，不重做

## 5. 結構化提問 — 完成
- [x] 5.1 `ask` 工具（多選、阻塞、不儲存、略過→「自己決定、別再問」）— `agent-runtime/src/tools.mjs`；`requestQuestion` 一路接（loop runCtx → engine ctx → createEngine 參數）；fail-closed 若無通道。tools-ask.test.mjs 5 tests
- [x] 5.2 前端渲染：CLI 選單（`bin/tui.mjs` requestQuestion）+ VS Code 卡片（agentCoreBackend callback → extension `questionRequest`/`questionReply` → webview `questionCard` 選項按鈕 + 跳過）

## 6. 驗收
- [ ] 6.1 單元：同 session 重入併入、不同 session 併行
- [ ] 6.2 整合：回合中 steer → 下一步即轉向；queue → 回合後依序執行
- [ ] 6.3 整合：步數到頂 → 摘要收尾而非截斷
- [x] 6.4 單元：ask 回選擇 / fail-closed / 略過即「別再問」/ 輸入驗證（tools-ask.test.mjs 5 tests）
- [ ] 6.5 openspec validate + archive（question 完成；coordinator+steer/queue §2-3 未做）
