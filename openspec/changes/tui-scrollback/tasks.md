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
- [x] 2.3 **live wiring：聚合標頭接進 transcript**（本次交付）
      → 重新盤點後發現先前備註的前提有誤：連續唯讀工具呼叫（Read/ListFiles/Search）
        **本來就在 insert 時折疊**成單一 exploring `ExecCell`（`ExecCell::add_call`，
        `chatwidget/command_lifecycle.rs` 路由；non-exploring 呼叫使 add_call 回 false →
        flush → 斷開 run），且折疊 cell 只在 run 斷開時寫進 terminal scrollback 一次 —
        無需攔截 history push、無逐幀重聚合、無高度快取問題（active cell 每幀重繪 +
        `bump_active_cell_revision` 失效化；commit 後 cell 不再變動，resize reflow 從
        `transcript_cells` 重繪同一標頭）。
      → 缺的只是動詞群組摘要行：`ExecCell::verb_group_events()`（exec_cell/model.rs，
        ParsedCommand→VerbGroupKind 分類：Read→Read/ReadSkill、ListFiles→ListDir、
        Search→Search；以檔名/路徑/query 作 dedup source；failed=exit!=0 每 call 記一次；
        running=duration.is_none()）+ exploring 標頭改渲染 `aggregate()` 標籤
        （exec_cell/render.rs：「Read 3 files, Searched 2 patterns · 1 failed」，
        時態隨 is_active 切換）。細節行全數保留（摘要下方 + Ctrl+T transcript），無資訊損失。
      → 門檻：run >= 3 calls（`VERB_GROUP_FOLD_THRESHOLD = 3`）才換摘要標頭，否則維持
        既有「Exploring/Explored」。
      → gate：`UNIEAI_TUI_VERB_GROUPS` / `CODEX_TUI_VERB_GROUPS`（=1/true/on/yes），啟動時
        pin（lib.rs run_main）。**預設 OFF**：(a) 正式 `tui.verb_groups` config key 須改
        codex-core `Config`（超出本次僅動 tui/ 的範圍，deferred）；(b) OFF 保證既有
        exploring 標頭 snapshot 逐位元不變（chatwidget::tests::exec_flow 50 tests 全綠驗證）。
      → 失敗/中斷邊界：走「failure count 浮上摘要」路線（`· N failed`；中斷時
        `finalize_active_cell_as_failed` → `mark_failed` → exit 1 → 同一路徑）；失敗呼叫
        的完整輸出照舊在細節行與 transcript overlay 可查。
      → 測試（exec_cell/render.rs，8 新測試 + 1 insta snapshot
        `verb_group_folded_exploring_cell`）：真實 constructor 上的分類、add_call 折疊
        （第 3 個同群呼叫入同 cell；Unknown/exec 斷開）、摘要渲染、時態、失敗計數、
        門檻、gate off 回歸。
      → 仍 deferred：跨 cell 折疊（MCP tool cells / web-search cells 為獨立 HistoryCell，
        需在 `add_boxed_history` 做 hold-back 緩衝、改變 scrollback commit 時序 — 高風險，
        `classify_tool` 名稱分類器與 WebSearch/Subagent/McpTool 桶為此保留）。

## 3. sticky 標頭
- [ ] 3.1 釘頂/推離的 1D 佈局 + 單元測試 — 延後（不在本次動詞群組交付範圍）

## 4. tool card 呈現
- [ ] 4.1 diff 漸進上色（hunk → 全檔 scope，含 cap） — 延後
- [ ] 4.2 read 首尾預覽 + 內嵌圖片/PDF — 延後

## 5. 驗收
- [x] 5.1 snapshot：聚合行時態/複數/失敗
      → 模組內單元測試涵蓋時態/複數/失敗/去重 + render 端 insta snapshot
        `exec_cell/snapshots/…verb_group_folded_exploring_cell.snap`
        （「Read 2 files, Searched 1 pattern, Listed 1 dir · 1 failed」+ 細節行）
- [ ] 5.2 單元：sticky clip 數學 — 延後（隨 3.1）
- [ ] 5.3 openspec validate + archive — 延後

## 備註：整合現況
- 動詞群組已 **live**（見 2.3）：exec 探索 run 的 insert-time 折疊沿用既有
  `ExecCell::add_call` 機制，摘要標頭由 `scrollback_verb_group::aggregate` 渲染，
  gate 預設 OFF（env 開啟：`CODEX_TUI_VERB_GROUPS=1`）。`cargo check -p codex-tui`
  綠燈、零警告；exec_cell/scrollback_verb_group/exec_flow/history_cell 套件全綠
  （history_cell 4 個既有環境性失敗除外：版本字串 snapshot 過期 v0.0.0 + debug=0
  libunwind abort，皆與本改動無關）。
- 先前「每個工具呼叫是獨立 Box<dyn HistoryCell>、需攔截 history push」的備註對
  exec 探索呼叫（最大宗）**不成立**，已由 2.3 修正；對 MCP/web-search cells 仍成立，
  故跨 cell 折疊續列 deferred。sticky 標頭（3.x）、tool card 呈現（4.x）維持 deferred。
