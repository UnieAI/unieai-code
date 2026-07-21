# Tasks: coding-tools

## 1. 研究對照
- [ ] 1.1 讀 opencode `file-mutation.ts:61,144-149`、`tool/edit.ts:42-53,113-116,162-195`（陳舊守衛、BOM/換行、外部目錄）
- [ ] 1.2 讀 `tool/write.ts:75-91` + `lsp/diagnostic.ts`（診斷注回）、`tool-output-store.ts:74-136,176-204`（spill + 保留）
- [ ] 1.3 讀 grok `grok_build_hashline/edit/mod.rs`、`range_policy.rs`（錨點編輯）、`lsp/{client,manager}.rs`（LSP 導航）

## 2. 編輯守衛（易，先行）
- [ ] 2.1 內容雜湊陳舊守衛
- [ ] 2.2 BOM/換行保真
- [ ] 2.3 外部目錄核准閘

## 3. 工具輸出 spill（易）
- [ ] 3.1 超限寫磁碟 + 頭尾預覽 + 存檔標記
- [ ] 3.2 grep 可搜 spill；保留清掃

## 4. LSP 診斷回饋（中，需 LSP runtime）
- [ ] 4.1 write/apply_patch 後取診斷、severity-1 注回（每檔上限、含他檔）

## 5. 錨點編輯 + LSP 導航（難，後行）
- [ ] 5.1 hashline_edit 錨點編輯（快照驗證、由下而上）
- [ ] 5.2 LSP 雙後端 goto/references（LSP 主、tree-sitter 輔）

## 6. 驗收
- [ ] 6.1 單元：陳舊守衛拒寫、BOM/CRLF 無假 diff、外部目錄需核准
- [ ] 6.2 整合：寫入產生 error → 診斷注回
- [ ] 6.3 整合：巨量輸出 spill + grep 命中
- [ ] 6.4 openspec validate + archive
