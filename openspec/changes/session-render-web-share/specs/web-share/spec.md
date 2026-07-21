# web-share

## ADDED Requirements

### Requirement: 唯讀 web session 檢視

系統 SHALL 能在 web 以唯讀方式呈現一場 session，透過共用渲染元件庫顯示其訊息與工具活動，並提供可分享的連結。

#### Scenario: 開啟分享連結

- WHEN 使用者開啟一個 session 分享連結
- THEN web 以唯讀方式呈現該 session 的對話與工具活動，使用與面板相同的渲染

### Requirement: 分享隱私邊界

產生分享時，系統 SHALL 明確界定哪些內容公開，且分享為唯讀（觀看者不可操作該 session）。

#### Scenario: 分享為唯讀

- WHEN 一場 session 被分享並由他人開啟
- THEN 觀看者只能檢視，不能送出訊息、核准或改變該 session 狀態
