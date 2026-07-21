# Tasks: tui-rewind-diff

## 1. 研究對照
- [~] 1.1 讀 grok `views/rewind.rs`（RewindMode、RewindPointInfo、衝突）、`views/jump.rs`（ScrollAnchor 還原）
      → 外部 repo 不在磁碟，依規格描述 + 既有知識重建；RewindMode/RewindPoint/衝突落地於 `rewind_model.rs`、
        ScrollAnchor 寬度穩定還原落地於 `jump_anchor.rs`。
- [~] 1.2 讀 opencode `feature-plugins/system/diff-viewer.tsx`（split/unified、檔案樹、來源切換、審閱狀態）
      → 同上，unified-diff 解析 + split 配對 + 檔案清單審閱狀態 + 來源切換落地於 `diff_viewer_model.rs`。
- [ ] 1.3 對接 session-checkpoint-revert 的 revert API
      → **延後**：本階段只做純模型，不呼叫任何 revert API（見 2.2）。

## 2. 回捲 picker
- [~] 2.1 Esc-Esc 開啟；回捲點列表（預覽/快照數/變更旗標）
      → 純模型落地於 `rewind_model.rs`：`RewindPoint{index,prompt_preview,snapshot_count,has_file_changes}`、
        `RewindPoint::from_candidates`（有序清單建構、prompt 預覽壓縮並守 char boundary 截斷）、
        `RewindPicker`（clamped 選取游標 move_up/move_down、selected_point）。
        **未做**：Esc-Esc live 鍵路徑攔截 + picker render（高風險 live 整合，明確延後）。
- [~] 2.2 三軸模式切換；套用前預覽 + 衝突呈現
      → `RewindMode{ConversationOnly,FilesOnly,Both}` + `cycle`/`restores_files`/`restores_conversation`/`label`；
        `RewindPreview::assemble`（純資料：ConversationOnly→無檔案無衝突；FilesOnly/Both→列出還原檔案 + `Conflict{path,kind}`）、
        `RewindPicker::preview`（隨選取 + 模式變動）。
        **未做**：實際呼叫 agent-core revert API 套用回捲（破壞性操作，明確延後）。

## 3. /jump 導航
- [~] 3.1 回合列表 + 游標即時捲動；寬度穩定 anchor 還原
      → `jump_anchor.rs`：`JumpList`（`Turn` 邏輯行清單 + clamped 游標 move_up/move_down、
        `scroll_target(width)`=游標回合頂端的 wrapped-row）、`ScrollAnchor{turn,line}`（邏輯座標、寬度無關）、
        `capture(top_row,width)`/`restore(anchor,width)`（換寬度後仍落在同一邏輯行；測試以 W1=20/W2=50 驗證
        絕對 row 漂移但邏輯行不變，且 naive 沿用舊 row 會落到不同行）。
        **未做**：真實 transcript 即時捲動 + Esc 還原的 live 串接（延後）。

## 4. diff 檢視器
- [~] 4.1 split/unified、檔案樹、hunk 跳轉
      → `diff_viewer_model.rs`：`parse_unified_diff`（多檔 `diff --git`/`---`/`+++`、`@@ -a,b +c,d @@` 計數可省略、
        以 hunk 行預算消費 body 故 `+++nested` 不誤判為 header、`/dev/null` 新檔）、
        `ViewMode{Unified,Split}::toggle`、`split_rows`（context 兩側、del/add 依序配對、多餘 del→左、多餘 add→右）、
        `FileList`（select_prev/next clamped，作為檔案樹/清單基礎）。
        **未做**：全螢幕 render 與 hunk 跳轉的 live 導航串接（延後）。
- [~] 4.2 標記已審閱；來源切換（工作區/main/上一回合）
      → `FileList` per-file `ReviewState{Reviewed,Unreviewed}`、`toggle_reviewed`、`all_reviewed`、
        `next_unreviewed`（跳過已審閱、環繞）；`DiffSource{Workspace,MainBranch,PrevTurn}::cycle`+`label`。
        **未做**：實際產生各來源 diff 的 git 呼叫（工作區/main/上一回合），本階段僅追蹤選取來源（明確延後）。

## 5. 驗收
- [~] 5.1 整合：回捲預覽→衝突→套用（接 revert API）
      → 純資料鏈（preview→conflicts）已備妥並單元測試；**接 revert API 的實際套用延後**（見 1.3/2.2）。
- [~] 5.2 snapshot：diff 檢視器、jump
      → 以純模型單元測試取代 render snapshot（27 tests：`rewind_model` 10、`jump_anchor` 6、`diff_viewer_model` 11）。
        render/full-screen snapshot 待 live 整合階段補（延後）。
- [~] 5.3 openspec validate + archive
      → `openspec validate tui-rewind-diff --strict` 通過；archive 待整體 change 收尾。

## 備註（本階段範圍）
所有 live wiring（Esc-Esc 鍵路徑、/jump 即時捲動與 Esc 還原、全螢幕 diff render 與 hunk 導航）、
revert API 實際呼叫、以及各來源 diff 的 git 產生，皆**明確延後**（高風險）；本階段僅交付自足、單元測試過的純核心模型，
於 `lib.rs` 以 `mod …;` 註冊但未接入 live 事件迴圈／render 路徑。
