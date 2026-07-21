# Proposal: coding-tools

**Target:** unieai-code（coding 工具層）· 來源：opencode `file-mutation.ts`、`tool/edit.ts`、`tool/write.ts`、`lsp/diagnostic.ts`、`tool-output-store.ts`；grok-build `grok_build_hashline/edit/`、`lsp/{client,manager}.rs`

## Why

coding 工具還可以更穩、更會給模型回饋。幾個對症的小強化：編輯前的**內容雜湊陳舊守衛**（比 mtime 強）、**BOM/換行保真**（避免假 diff）、寫檔後把 **LSP 診斷**回饋給模型、工具輸出**溢出到磁碟且可 grep**、以及 grok 的**錨點式編輯**與**LSP 雙後端導航**。

## What Changes

- **內容雜湊陳舊守衛**：寫檔前比對「當前 bytes 是否仍等於讀取時的 bytes」，不符回「檔案被改過，重讀再編輯」，比 mtime 檢查強。
- **BOM/換行保真**：編輯保留 UTF-8 BOM 與原換行風格，避免整檔假 diff。
- **外部目錄閘**：絕對外部路徑需獨立的 `external_directory` 核准，與一般編輯核准分開。
- **LSP 診斷回饋**：write/apply_patch 後在語言伺服器 touch 檔案、等診斷，把 severity-1 錯誤以 `<diagnostics>` 區塊注回模型（每檔上限 20，含其他檔案的錯誤）。
- **工具輸出磁碟 spill + grep**：輸出超限（2000 行/50KiB）寫磁碟，模型看頭+尾預覽 + 「完整內容存在 <path>」標記，7 天保留；grep 工具可搜這些 spill 檔。
- **錨點式編輯（hashline_edit）**：採 grok 的錨點 token 編輯（來自 read/search）、對讀取前快照驗證、由下而上套用避免行位移——作為既有 apply_patch 模糊匹配之外的另一路。
- **LSP 雙後端導航**：goto_definition/find_references 以 LSP 為主、tree-sitter scope-graph 為輔。

## Capabilities

### New Capabilities
- `edit-safety`：內容雜湊陳舊守衛、BOM/換行保真、外部目錄閘。
- `edit-feedback`：LSP 診斷注回、工具輸出磁碟 spill 與 grep-over-spill。
- `code-navigation`：LSP 雙後端 goto/references。
- `anchor-edit`：錨點式編輯工具。

## Impact

- **落點：unieai-code**（codex-rs coding 工具 + agent-runtime domain 工具）。工具輸出 spill 的 store 部分可與 agent-core 對齊，grep-over-spill 在此。
- 現行 codex 已有 apply_patch 模糊匹配與 sandbox；本 change 為疊加，設計成 additive 以壓低 rebase 衝突面。
- 風險：LSP 進程管理（啟動、崩潰、多語言）成本；先做編輯守衛與 spill（易），LSP 相關後行（難）。
