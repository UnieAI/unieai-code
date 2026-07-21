# Tasks: coding-tools

## 1. 研究對照
- [ ] 1.1 讀 opencode `file-mutation.ts:61,144-149`、`tool/edit.ts:42-53,113-116,162-195`（陳舊守衛、BOM/換行、外部目錄）
- [ ] 1.2 讀 `tool/write.ts:75-91` + `lsp/diagnostic.ts`（診斷注回）、`tool-output-store.ts:74-136,176-204`（spill + 保留）
- [ ] 1.3 讀 grok `grok_build_hashline/edit/mod.rs`、`range_policy.rs`（錨點編輯）、`lsp/{client,manager}.rs`（LSP 導航）

## 2. 編輯守衛（易，先行）
- [x] 2.1 內容雜湊陳舊守衛（`agent-runtime/src/tools.mjs`：closure `readHashes` Map（resolved abs → `hashContent` SHA-1），`read` 記錄模型看到的 bytes；`edit`／`write`-over-existing 前以 `staleGuard` 比對當前 disk hash，不符回「File <path> changed on disk since you last read it. Re-read it, then edit again.」並不改檔；無先前 read 則放行（create-new/first-write 不擋）；每次成功寫入後刷新 snapshot，連續 edit 不誤觸）
- [x] 2.2 BOM/換行保真（純 helper `hasBom`／`stripBom`／`detectNewline`／`encodeLike` 皆 export；`edit` 在 normalized-LF + 去 BOM 檢視上做 search/replace，再以原檔 BOM＋主換行風格 re-encode；`write`-over-existing 同樣把模型 LF 內容 re-encode 回原風格。CRLF+BOM 檔往返無假 diff；純 LF 無 BOM 檔位元組不變（無回歸））
- [~] 2.3 外部目錄核准閘（純 helper `isExternalPath(workspace, targetPath)` export，resolve + containment，處理 `..` 逃逸與共享前綴 sibling；`read`/`write`/`edit` 對 workspace 外絕對路徑經 `gateExternal`：預設拒絕並回明確 refusal，不再靜默成功；若 host 有 `runCtx.requestApproval` 則以 **distinct `kind:"external_directory"`** 升級核准，或以 `allowExternal` 旗標／`externalAllowlist` opt-in 放行。**DEFERRED**：engine 層對 `external_directory` kind 的完整 approval-prompt 佈線與 approval-rules 記憶（runCtx 已能傳 requestApproval，label/kind 已發出，但前端渲染與規則儲存尚未接）)

## 3. 工具輸出 spill — 完成
- [x] 3.1 超限寫磁碟 + 頭尾預覽 + 存檔標記（`agent-runtime/src/tool-output-store.mjs` `spillIfLarge`；store 在 UNIEAI_HOME/tool-output；bash 正常退出輸出與 read 都接上；store 失敗 fail-safe 退回截斷）
- [x] 3.2 `read_output(id, grep?)` 取回工具（跨 workspace 限制、只讀 store）+ grep 過濾行 + 7 天保留清掃。tool-output-store.test.mjs 5 tests

## 4. LSP 診斷回饋（中，需 LSP runtime）
- [ ] 4.1 write/apply_patch 後取診斷、severity-1 注回（每檔上限、含他檔）

## 5. 錨點編輯 + LSP 導航（難，後行）
- [ ] 5.1 hashline_edit 錨點編輯（快照驗證、由下而上）
- [ ] 5.2 LSP 雙後端 goto/references（LSP 主、tree-sitter 輔）

## 6. 驗收
- [x] 6.1 單元：陳舊守衛拒寫、BOM/CRLF 無假 diff、外部目錄需核准 — `agent-runtime/src/tools-edit-safety.test.mjs` 16 tests（helper：hasBom/stripBom、detectNewline、encodeLike、hashContent、isExternalPath；handler：edit/write 陳舊拒寫、無 read 放行、連續 edit 不誤觸、CRLF+BOM 往返、LF 無回歸、外部路徑預設拒＋approval(external_directory)＋allowExternal 放行）。`node --test` `# fail 0`、乾淨退出，既有 tools-ask/tools-bash-abort/tool-output-store 13 tests 無回歸
- [ ] 6.2 整合：寫入產生 error → 診斷注回
- [ ] 6.3 整合：巨量輸出 spill + grep 命中
- [ ] 6.4 openspec validate + archive
