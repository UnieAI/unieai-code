# Tasks: tui-scrollback

## 1. 研究對照
- [ ] 1.1 讀 grok `scrollback/state/verb_group.rs`（run_step、bucket label、去重）
- [ ] 1.2 讀 `scrollback/sticky.rs`（clip_top、pushed/pinned 數學）
- [ ] 1.3 讀 `blocks/tool/edit.rs`（漸進上色 phase、cap）、`blocks/tool/read.rs`（首尾預覽、媒體）

## 2. 動詞群組聚合
- [ ] 2.1 分桶 + 複數化 + 時態切換 + 失敗計數
- [ ] 2.2 去重（URL / child-session-id）

## 3. sticky 標頭
- [ ] 3.1 釘頂/推離的 1D 佈局 + 單元測試

## 4. tool card 呈現
- [ ] 4.1 diff 漸進上色（hunk → 全檔 scope，含 cap）
- [ ] 4.2 read 首尾預覽 + 內嵌圖片/PDF

## 5. 驗收
- [ ] 5.1 snapshot：聚合行時態/複數/失敗
- [ ] 5.2 單元：sticky clip 數學
- [ ] 5.3 openspec validate + archive
