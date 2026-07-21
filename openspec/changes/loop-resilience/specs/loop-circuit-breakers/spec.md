# loop-circuit-breakers

## ADDED Requirements

### Requirement: 連續相同工具呼叫斷路

當模型連續 3 次發出完全相同的工具呼叫（同工具名＋同輸入）時，系統 SHALL 觸發一次權限提示以打斷可能的無效迴圈，而非持續執行。

#### Scenario: 三次相同呼叫

- WHEN 連續三次工具呼叫的名稱與輸入完全相同
- THEN 系統升起 doom-loop 權限提示，等使用者決定是否放行

### Requirement: 子任務級聯取消

取消一個 session 時，系統 SHALL 沿 `parentSessionId` 鏈以 BFS 取消其所有子孫背景任務。

#### Scenario: 取消含子任務的 session

- WHEN 使用者取消一個已 spawn 子任務的 session
- THEN 該 session 及其所有子孫背景任務皆被取消，不留孤兒任務
