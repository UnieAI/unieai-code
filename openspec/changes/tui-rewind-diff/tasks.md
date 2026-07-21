# Tasks: tui-rewind-diff

## 1. 研究對照
- [ ] 1.1 讀 grok `views/rewind.rs`（RewindMode、RewindPointInfo、衝突）、`views/jump.rs`（ScrollAnchor 還原）
- [ ] 1.2 讀 opencode `feature-plugins/system/diff-viewer.tsx`（split/unified、檔案樹、來源切換、審閱狀態）
- [ ] 1.3 對接 session-checkpoint-revert 的 revert API

## 2. 回捲 picker
- [ ] 2.1 Esc-Esc 開啟；回捲點列表（預覽/快照數/變更旗標）
- [ ] 2.2 三軸模式切換；套用前預覽 + 衝突呈現

## 3. /jump 導航
- [ ] 3.1 回合列表 + 游標即時捲動；寬度穩定 anchor 還原

## 4. diff 檢視器
- [ ] 4.1 split/unified、檔案樹、hunk 跳轉
- [ ] 4.2 標記已審閱；來源切換（工作區/main/上一回合）

## 5. 驗收
- [ ] 5.1 整合：回捲預覽→衝突→套用（接 revert API）
- [ ] 5.2 snapshot：diff 檢視器、jump
- [ ] 5.3 openspec validate + archive
