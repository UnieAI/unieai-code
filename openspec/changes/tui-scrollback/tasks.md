# Tasks: tui-scrollback

## 1. 研究對照
- [x] 1.1 讀 grok `scrollback/state/verb_group.rs`（run_step、bucket label、去重）
- [ ] 1.2 讀 `scrollback/sticky.rs`（clip_top、pushed/pinned 數學） — 延後（sticky 標頭未實作）
- [~] 1.3 讀 `blocks/tool/edit.rs`、`blocks/tool/read.rs` — 改為研究 codex 對應的
      `history_cell/{search,exec,mcp}.rs` 與 `Box<dyn HistoryCell>` 呈現模型；grok blocks 未逐檔讀

## 2. 動詞群組聚合
- [x] 2.1 分桶 + 複數化 + 時態切換 + 失敗計數
      → `codex-rs/tui/src/scrollback_verb_group.rs`（自足、16 個單元測試全綠）
- [x] 2.2 去重（URL / child-session-id）
      → `ToolEvent.sources` + `VerbGroupAccumulator` distinct-count override

## 3. sticky 標頭
- [ ] 3.1 釘頂/推離的 1D 佈局 + 單元測試 — 延後（不在本次動詞群組交付範圍）

## 4. tool card 呈現
- [ ] 4.1 diff 漸進上色（hunk → 全檔 scope，含 cap） — 延後
- [ ] 4.2 read 首尾預覽 + 內嵌圖片/PDF — 延後

## 5. 驗收
- [~] 5.1 snapshot：聚合行時態/複數/失敗
      → 以模組內 `#[cfg(test)]` 單元測試涵蓋時態/複數/失敗/去重；render snapshot 待整合後補
- [ ] 5.2 單元：sticky clip 數學 — 延後（隨 3.1）
- [ ] 5.3 openspec validate + archive — 延後

## 備註：整合現況
- 純聚合核心已 land 並通過測試；`cargo check -p codex-tui` 綠燈、零警告。
- 尚未接進實際 render pipeline：codex 每個工具呼叫是獨立的 `Box<dyn HistoryCell>`，
  無 grok 的中央 `ScrollbackEntry`/`RenderBlock` 分類層。要折疊連續工具呼叫需攔截
  history push、抑制個別 cell、插入會逐幀重聚合的 summary cell，並處理 transcript/
  捲動/高度快取 — 屬高風險改動，故在乾淨點停手，僅交付自足且已測的核心模組。
