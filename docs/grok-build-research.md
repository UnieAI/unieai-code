# grok-build + codex-rs 逐行研究 → UnieAI Code 移植路線圖

來源:xai-org/grok-build(Rust coding agent,17k stars)四路並行逐行研究
(迴圈生命週期 / 開源模型適配 / prompts 與工具 / context 管理),2026-07-18。
本文件按「移植價值 × SWE-bench 失敗模式對症程度」排序,並標注落點層
(agent-core = 通用迴圈,unieai-code = coding 層)。

## 已完成移植

- ✅ **edit 工具四層模糊匹配**(unieai-code `tools.mjs`)—— 精確 → 去尾空白 →
  去頭尾空白 → Unicode 正規化(智慧引號/破折號/特殊空白→ASCII),外加
  「尾端多餘換行重試」。每層都保持唯一性檢查,回報訊息註明用了哪層。
  對症:小模型抄寫檔案內容時的空白/標點漂移造成 edit 失敗。
  (grok-build `seek_sequence.rs` 4-tier + `apply.rs` trailing-newline retry)

## P0 — 直接對症 SWE-bench 失敗模式

1. **Skeptic 驗證 + 缺口重播**(agent-core completionCheck 擴充 + coding 層驗證器)
   - 模型宣稱完成 → 獨立 LLM 驗證呼叫裁決;NotAchieved 的缺口清單
     **重播進後續每輪 prompt**,逼模型對具體 blocker 收斂(cap ~10 次驗證)
   - 對症:flask-4045「修主幹漏 sibling」 —— 驗證者會指出「endpoint 路徑還沒擋」
   - grok-build: `goal.rs:1937` drain→classifier、`goal_classifier.rs:38`、
     re-verify 升級梯 `goal_support.rs:449`(8 輪軟提醒 → 24 輪 STOP DRIFTING)
2. **放棄措辭偵測**(coding 層,completionCheck 內加一層)
   - 對最終答案最後一段跑 regex 面板(unable to proceed / stopping here /
     please …),配合「工作未完成」證據才 nudge;grok-build `goal_stop_detector.rs`
   - 對症:codex-stock/Qwen「分析完就收工」;agent-core 空手收工
3. **空回應/只有 reasoning → 可重試**(agent-core upstream.mjs)
   - `ReasoningOnly` / `NoVisibleContent` 分類為 transient 重試;
     content-filter 則終止不重試(防重試風暴)。grok-build `request_task.rs:540`
   - 對症:開源模型常見「只吐 think 就斷」

## P1 — 穩定性與容錯(通用層)

4. **雙計時器 stall 偵測**(agent-core upstream.mjs)—— transport 停滯計時器之外,
   加「內容感知」計時器:keepalive/空 delta 不算進展(per-event 分類器),
   只有實質 content/tool-arg delta 才重置。grok-build `chat_completions.rs:29-35`
5. **孤兒 tool-call 修復**(agent-core)—— 每次請求前掃描 history:移除孤兒
   tool 訊息、為沒有結果的 `tool_calls` 插入合成 tool result,防單筆損壞
   訊息讓 session 之後每請求都 400。grok-build `extensions/repair.rs`
6. **有 tool call 就強制 finishReason=tool_calls**(agent-core)—— 模型忘設
   finish_reason 時的容錯。grok-build `chat_completions.rs:259`
7. **Retry 矩陣細化**(agent-core net/upstream)—— 429 獨立低上限(2)、
   context 溢出無論狀態碼一律不重試、`x-should-retry: false` 尊重 /
   `true` 刻意忽略。grok-build `retry.rs:144-245`

## P2 — 品質與能力(較大工程)

8. **TodoGate 一般化**:completionCheck 已是同構;可加 fires 上限(theirs 2)
   與「放行時附交接說明」。grok-build `reminders.rs:88`
9. **反造假怠惰偵測**:獨立分類器對話 + 只餵 harness 真話(背景任務數、
   實測耗時),刻意排除模型自寫 todo;信心 ≥0.7 才 nudge、每 session 上限。
   grok-build `laziness.rs:485-519`
10. **Compaction 強化**(agent-core compaction.mjs):9 段式 FullReplace 摘要
    prompt、`<user_queries>` 防雪球抽出重掛、摘要控制標記零寬空白消毒、
    Verbatim→Fitted→Lossy 降級梯。grok-build `xai-grok-compaction/`
11. **tree-sitter scope-graph 工具**:`goto_definition`/`find_references` 掛成
    工具(不是塞 repo map 進 prompt),lazy 啟動、磁碟快取、fs-watcher 增量。
    grok-build `xai-codebase-graph/`
12. **工具描述升級**(coding 層,零成本):grep 的 .js/.ts import 警告與
    「at least N」計數、read 行號前綴 gotcha 說明、輸出截斷語意
    (丟棄式 vs 軟換行式,按用途選)。grok-build `truncate.rs:22-77`

## codex-rs 研究補充(本 repo 的 codex fork,SWE-bench 3/3 resolved 的 harness)

為什麼 codex 挖得深:**內層迴圈完全沒有步數上限**(grep 證實無 max_turns/max_steps),
續跑由「模型有沒有發 tool call」+ server `end_turn:false` 驅動;context 滿了觸發
壓縮後**繼續**而不是結束(turn.rs:348-382)。深度紀律在 prompt:

- UnieAI 精簡 prompt(`models-manager/src/gateway_instructions.md`,59 行)保留了
  股票版的行為槓桿、砍掉排版/計畫鷹架:
  - **「Act, don't announce」**(line 9):不准以「let me…/now I will…」收尾 ——
    還有工作就在同一 turn 發 tool call;純文字回覆 = 完成
  - 改狀態後**先驗證再宣稱成功**(line 11);失敗**不准原樣重試**(line 12)
  - patch 最小聚焦、看鄰檔慣例、跑專案自己的測試(lines 19-34)
- apply_patch 不是工具而是**攔截 shell 裡的 heredoc**,走結構化 parser + 模糊
  context 匹配 + TurnDiffTracker(shell.rs:140-144, apply_patch.rs)
- 輸出**中段截斷**保頭尾 + 原始大小 banner(output-truncation lib.rs:12-29)
- UnieAI provider:75 秒 stream idle + 3 次重試 + WebSocket→HTTPS 降級,
  重連使用者可見(model-provider-info lib.rs:343-372)
- stop hooks = 可程式化的「你真的完成了嗎」閘門(hook_runtime.rs:298-366)——
  與我們的 completionCheck 同構

### 已據此落地(2026-07-18 第三輪)

- ✅ coding 層 prompt 加入 act-don't-announce / 驗證後宣稱 / 失敗要變招(engine.mjs)
- ✅ maxSteps 48 → 96(高位保險絲;治理交給品質閘門,與兩家 uncapped 哲學對齊)
- ✅ bash 輸出改中段截斷含原始大小(tools.mjs)
- ✅ **skeptic 驗證 + 缺口重播**(engine.mjs `workspaceCompletionCheck`):
  未改檔 → mutation nudge;有改檔 → 獨立 LLM 以 diff+任務嚴格審查,
  非 ACHIEVED 就把缺口(≤5 條可行動 bullet)注入逼修,completionCheckMax=2

## 設計哲學筆記(長期方向)

- **步數上限退位,品質關卡上位**:grok-build 主 agent `max_turns` 預設
  None(無上限);防失控靠 TodoGate/驗證者/怠惰偵測/無進展熔斷
  (連 3 輪無進展 → 明示暫停)。我們 maxSteps 24→48 是過渡,終態應是
  完成契約驅動。
- **doom 偵測在 token 生成層**(server 回報 tail_repetition/low_logprob →
  中斷重採樣,獨立預算,超支後接受現狀),沒有工具重複計數器 ——
  我們的 progress-aware streak 是互補而非重複。
- **最小 system prompt(<16KB)+ 一切可變內容 lazy/budgeted 注入**;
  AGENTS.md 以 user 訊息注入且 compaction 全程保留;壓縮後 system prompt
  換成兩句話版。
- **prompt 金句可借**:「Fix the problem at the root cause rather than
  applying surface-level patches」「Do not attempt to fix unrelated bugs」
  「start tests as specific as possible… then broaden」「do not add tests
  to codebases with no tests」「surgical precision — don't overstep」。
