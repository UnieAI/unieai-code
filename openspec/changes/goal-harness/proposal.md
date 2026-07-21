# Proposal: goal-harness

**Target:** unieai-agent-core（品質關卡／完成契約）· 來源：grok-build `goal_planner.rs`、`goal_strategist.rs`、`goal_summarizer.rs`、`goal_tracker.rs`、`turn.rs`、`laziness_classifier.rs`

## Why

現行 completionCheck 是單一 skeptic 驗證 + 缺口重播。grok-build 的 `/goal` 已演化成**多角色 subagent 樂團**，各角色有不同的失敗語意，且完成續跑是**兩個獨立閘門**疊在取樣迴圈外——這是我們既有研究文件漏掉的最大缺口。移植可把「宣稱完成但沒做對」的失分池再往下壓。

## What Changes

- **多角色 goal subagents**（各為獨立 subagent，失敗語意不同）：
  - **planner**（fail-closed）：寫一份結構化 `plan.md` 契約；任何失敗都 PAUSE 該 goal（不讓壞計畫繼續）。
  - **strategist**（fail-open）：連續 N 次 NotAchieved 後出手，建議**結構性**補救；以 RAII guard 快照＋還原 `plan.md`，確保不汙染契約。
  - **summarizer**（fail-open，只一次）：ACHIEVED 時寫給使用者的結案摘要。
  - **verifier**：既有 skeptic 驗證（保留）。
- **gap 指紋停滯早退**：連續兩次相同的 gap 指紋 ⇒ 中止（避免對同一個 blocker 空轉）。
- **兩層 turn 續跑**：`run_goal_round_end()`（goal 續跑指令）與 `run_stop_gate()`（stop-hook 回饋，上限 8/回合）是兩個獨立機制包在取樣迴圈外，各有預算——取代現行把兩者混為一談的模型。
- **laziness 精修**：把既有信心閾值偵測補上**閒置觸發**（10s）、30 則訊息窗、三層結構第三層的定位（採 grok `laziness_classifier.rs`）。

## Capabilities

### New Capabilities
- `goal-roles`：planner/strategist/summarizer 的角色契約與失敗語意、plan.md 契約、gap 指紋停滯早退。
- `turn-continuation`：goal round-end 與 stop-hook gate 兩層獨立續跑及其預算上限；並把既有 completionCheck 行為（mutation nudge、skeptic 缺口重播）明文化為 verifier 角色。

### Modified Capabilities
（目前 `openspec/specs/` 尚無主 spec，故一律 ADDED；既有 completionCheck 程式行為由 turn-continuation 的「完成閘門」requirement 承接明文化。）

## Impact

- **落點：unieai-agent-core**：completionCheck 擴充為 goal 樂團；新增 plan.md 契約檔管理、subagent 角色 spawn、兩層續跑決策。角色 prompt 是唯一偏 coding 味的部分。
- 複雜度高（深度 subagent spawn + 持久化 plan 檔機器），建議分階段：先 verifier+planner，再 strategist/summarizer。
- 風險：plan.md 契約與 compaction/checkpoint 的互動；fail-closed 的 planner 不可因暫時性錯誤誤 PAUSE。
