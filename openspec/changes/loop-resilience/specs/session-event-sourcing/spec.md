# session-event-sourcing

## ADDED Requirements

### Requirement: 事件溯源 session 與雙 adapter

回合 SHALL 把 domain 事件寫成耐久紀錄，並經單一純投影 reducer 折成訊息狀態；同一 reducer SHALL 同時服務記憶體與持久化（SQLite）adapter，使直播渲染與落地儲存共用相同折疊邏輯。

#### Scenario: 串流與持久化一致

- WHEN 一個回合產生串流事件
- THEN 記憶體投影與持久化投影由同一 reducer 得到相同訊息狀態

### Requirement: 崩潰復原

系統啟動時 SHALL 把上一輪殘留為 pending/running 的工具標記為 failed，使被中斷的回合可重播且不卡在未完成的工具狀態。

#### Scenario: 程序中途死亡後重啟

- WHEN 程序在某工具執行中死亡、之後重啟
- THEN 該工具被標為 failed，session 可載入並繼續，而非卡死於 pending
