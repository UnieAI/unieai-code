# Tasks: turn-steering

## 1. 研究對照
- [ ] 1.1 讀 opencode `session/run-coordinator.ts:24-104`（single-flight/wake/interrupt/接續 drain）
- [ ] 1.2 讀 `session/input.ts` + `runner/llm.ts:190-196`（steer 重設步數為 1）與 queue drain
- [ ] 1.3 讀 `runner/max-steps.ts` + `runner/llm.ts:202-213`（卸工具 + toolChoice none + 強制摘要）
- [ ] 1.4 讀 `question.ts` + `tool/question.ts`（提問原語、不儲存、略過即止）

## 2. 單流協調器（agent-core）
- [ ] 2.1 per-session key 序列化 + 跨 session 併行
- [ ] 2.2 run() 併入進行中 run；wake() 合併單一後續；interrupt() 停止並等清理
- [ ] 2.3 成功且有待 wake → 接續下一次 drain

## 3. steer / queue
- [ ] 3.1 steer：折進當前回合 + 步數預算重設為 1
- [ ] 3.2 queue：外層迴圈依序 drain
- [ ] 3.3 與 completionCheck/goal 續跑互動：轉向後不被完成閘門誤判收工

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
