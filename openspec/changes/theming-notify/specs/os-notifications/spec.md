# os-notifications

## ADDED Requirements

### Requirement: 背景 session 完成通知

當一個未聚焦（背景）的 session 完成時，系統 SHALL 發出原生 OS 桌面通知，並 MAY 依事件類型播放對應音效（done/error/permission/question/subagent_done）。聚焦中的 session SHALL NOT 發出干擾通知。

#### Scenario: 背景 session 完成

- WHEN 使用者切走、某背景 session 完成回合
- THEN 系統發桌面通知（並依事件播放音效），提示可回來查看

#### Scenario: 前景 session 不打擾

- WHEN 使用者正聚焦於某 session 且該 session 完成
- THEN 不發桌面通知
