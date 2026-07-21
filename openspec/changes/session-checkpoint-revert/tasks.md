# Tasks: session-checkpoint-revert

## 1. 研究對照
- [x] 1.1 讀 opencode `snapshot.ts`（tree-hash 快照、shadow git）與 `session/revert.ts`（映射還原 + stage/clear/commit）
- [x] 1.2 盤點現行 agent-core session：記錄至回合邊界（`saveSession`）；本 change 加 checkpoints 欄位

## 2. 影子 git 快照（agent-runtime，安全/唯讀半）
- [x] 2.1 `snapshot.mjs`：`initShadow`（GIT_DIR/GIT_WORK_TREE 指向 shadow，禁用 global/system config）
- [x] 2.2 `snapshotWorkspace`（add -A + write-tree → tree hash）；驗證不動使用者 .git（整合測試）
- [x] 2.3 ignore：沿用 workspace .gitignore（整合測試驗證 ignored/ 不入快照）
- [x] 2.4 engine 每回合後快照，`checkpoints[{messageIndex,tree}]` 存進 session、resume 還原、engine 暴露 getter
- [ ] 2.5（後續）per-step 快照（目前 per-turn；更細需 loop hook）

## 3. Per-message 足跡
- [~] 3.1 目前用「回合邊界 checkpoint」取代 per-message 足跡（回捲到整回合、恢復整工作區到該 tree）。per-file 精準映射為後續精修

## 4. Revert 服務
- [x] 4.1 純規劃 `revert-plan.mjs`：`planRevert`（restore tree at/before target + drop messages）、`revertFileActions`（A→remove / M·D→restore）。7 tests
- [x] 4.2 三軸（all / conversation / files）— planRevert mode 參數
- [x] 4.3 差異預覽用料：`listChangedPaths`、`readFileAt`（唯讀，供 diff/預覽）
- [ ] 4.4 **破壞性 apply（stage/clear/commit + 衝突偵測）刻意未做** — 留給 tui-rewind-diff 一起，確保有預覽才覆寫檔案

## 5. 對外 API
- [ ] 5.1 供 CLI/VS Code 的 revert API（stage/clear/commit/預覽）— 與 tui-rewind-diff 一起

## 6. 驗收
- [x] 6.1 整合：快照不動使用者 .git（snapshot.test.mjs）
- [x] 6.2 單元：planRevert 三軸 + 選 checkpoint（revert-plan.test.mjs）
- [ ] 6.3 衝突路徑 — 隨 apply 一起做
- [ ] 6.4 openspec validate + archive（唯讀半完成，apply 未做）
