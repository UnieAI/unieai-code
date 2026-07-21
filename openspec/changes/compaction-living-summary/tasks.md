# Tasks: compaction-living-summary

## 1. 研究對照（前置，不寫產品碼）
- [ ] 1.1 讀 opencode `packages/core/src/session/compaction.ts:16-46,128-168,225-236`：骨架欄位、合併提示、分割演算法、兩個觸發、防迴圈守衛
- [ ] 1.2 讀 grok-build `xai-grok-shell/src/session/two_pass.rs`：95/5 分割、NOTE₁→NOTE₂ 改寫
- [x] 1.3 盤點現況：agent-core `src/compaction.mjs` 是機械 PRUNE（舊工具輸出截 400 字）→ TRIM（丟舊回合、切 user 邊界）；`loop.mjs:244-258` 已有單次 overflow 恢復。複用 `estimate/textOf/selectRecentSplit`
- [x] 1.4 盤點 agent-runtime `engine.mjs` session 形狀（messages const、saveSession）；`callModelJson` 回傳純文字可作摘要呼叫

## 2. 滾動結構摘要（agent-core 純函式）
- [x] 2.1 定義骨架常數與摘要提示（`LIVING_SUMMARY_SYSTEM`：保留仍為真／移除過時／併入新增；明令保留路徑/符號/指令/錯誤字串）
- [x] 2.2 `compactWithSummary({messages,prevSummary,summarize,ctx})`：no-op 於預算下；超預算則折 head 成摘要、合併 prevSummary（不重摘）
- [x] 2.3 逐字近況尾巴：複用 `selectRecentSplit`（`KEEP_TOKENS` 預設 8000、切 user 邊界）
- [x] 2.4 摘要輸入的工具輸出截斷（`SUMMARY_TOOL_OUTPUT_CAP` 2000 字元，`renderTranscript`）
- [x] 2.5 摘要函式吃 caller 供的 `summarize` callback，模組本身無 IO（純函式、以測試鎖住）

## 3. engine 層接線（agent-runtime）
- [x] 3.1 回合結束後（off critical path）呼叫 `compactWithSummary`，`messages.splice` 就地替換、摘要寫回 session（`saveSession({summary})`）
- [x] 3.2 下一回合歷史 = 系統提示 + `<conversation_summary>` + 逐字尾巴；resume 還原 `rollingSummary`
- [x] 3.3 摘要呼叫 fail-open：try/catch 包住，失敗不動 messages、不阻塞回合結果
- [x] 3.4 摘要呼叫暫用 activeModel（TODO 標記接 provider-hardening 小模型），maxTokens 1500

## 4. Two-pass 長歷史特例
- [x] 4.1 長度門檻判定（`twoPassTokens`，預設 24000，`AGENT_1_0_COMPACT_TWOPASS_TOKENS` 覆寫）
- [x] 4.2 95% 中間摘要 → NOTE₁（`splitByTokenFraction` + `summarizeHead` pass1）
- [x] 4.3 NOTE₁ + 5% 尾巴 → 最終滾動摘要（pass2 以 NOTE₁ 當 existing summary）。4 tests（split 不丟訊息、單/雙 pass、note1 餵 pass2）

## 5. 相容與退路
- [x] 5.1 stateless PRUNE→TRIM 與 loop 內 overflow 恢復原樣保留（未動 `compactHistory`/`ensureLoopBudget`；既有測試仍過）
- [x] 5.2 config 旗標：沿用 `AGENT_1_0_COMPACT=off` 關閉（`compactWithSummary` 讀 `readConfig().enabled`）

## 6. 驗收
- [x] 6.1 單元：合併輸入含舊回合字面、system 保留、尾巴逐字（compaction-summary.test.mjs，9 tests）
- [x] 6.2 單元：折疊後尾巴仍切 user 邊界（複用 selectRecentSplit，測試涵蓋）
- [ ] 6.3 整合：模擬 provider 回 context-overflow → 既有機械恢復路徑不變（既有 loop.test 已涵蓋，未新增）
- [x] 6.4 單元：摘要呼叫失敗 → fail-open（測試涵蓋）
- [ ] 6.5 回歸：SWE-bench 軌跡抽樣（需 gateway，尚未跑）
- [ ] 6.6 openspec validate + archive（實作完成、尚未 archive）
