# goal-roles

## ADDED Requirements

### Requirement: 多角色 goal subagents

系統 SHALL 以多個具不同失敗語意的 subagent 角色驅動 goal 完成：planner（fail-closed）、strategist（fail-open）、summarizer（fail-open，僅一次）、verifier。各角色為獨立 subagent。

#### Scenario: planner 失敗即暫停

- WHEN planner 產出或更新 plan.md 契約時失敗
- THEN 該 goal SHALL 暫停（fail-closed），不以殘缺計畫繼續執行

#### Scenario: strategist 於連續未達成後出手

- WHEN verifier 連續 N 次判定 NotAchieved
- THEN strategist 出手，建議結構性補救，且以 guard 快照＋還原 plan.md 確保不汙染契約；strategist 自身失敗不中止 goal（fail-open）

#### Scenario: summarizer 於達成時只跑一次

- WHEN goal 被判定 ACHIEVED
- THEN summarizer 執行一次，產出給使用者的結案摘要；其失敗不影響 goal 完成狀態

### Requirement: plan.md 契約

planner SHALL 維護一份結構化的 plan.md 作為 goal 的執行契約；strategist 對其修改 SHALL 經由可還原的 guard，確保任一角色的失敗不會留下損壞的契約。

#### Scenario: strategist 改動後失敗

- WHEN strategist 在修改 plan.md 過程中失敗
- THEN guard SHALL 把 plan.md 還原為改動前的內容

### Requirement: gap 指紋停滯早退

當連續兩次驗證回報相同的 gap 指紋時，系統 SHALL 中止 goal 續跑，避免對同一 blocker 空轉。

#### Scenario: 重複相同缺口

- WHEN 連續兩次 NotAchieved 的 gap 指紋相同
- THEN 系統停止續跑並以未達成結束，不再重播相同缺口
