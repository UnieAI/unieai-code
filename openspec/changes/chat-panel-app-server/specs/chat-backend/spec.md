# chat-backend

## ADDED Requirements

### Requirement: App-server 常駐後端
Extension SHALL 以 stdio JSON-RPC 啟動並維護單一 `unieai app-server` process（每個 VS Code 視窗一個），完成 initialize 握手後跨回合復用同一 thread。

#### Scenario: 首次送出訊息
- WHEN 使用者在聊天面板送出第一則訊息
- THEN extension 啟動 app-server、完成 initialize、建立 thread，並在同一 process 上執行該回合

#### Scenario: 連續多回合
- WHEN 使用者於同一對話送出第二則訊息
- THEN 不重新 spawn process，沿用既有 thread，且回合啟動延遲低於 exec 模式

#### Scenario: extension 停用
- WHEN VS Code 停用或重載 extension
- THEN app-server child process SHALL 被終止，不留孤兒 process

### Requirement: Exec 降級路徑
當 app-server 無法使用時，extension SHALL 自動降級為既有 `exec --experimental-json` 模式並明確告知使用者。

#### Scenario: app-server 啟動失敗
- WHEN app-server spawn 失敗或連續 crash 三次
- THEN 顯示一次性「已降級為基本模式」通知，該 session 後續回合走 exec 路徑，聊天功能維持現狀（無互動核准與逐字串流）

### Requirement: 歷史 thread 接續
從歷史清單載入 session 後，extension SHALL 於 app-server 上 resume 同一 thread id。

#### Scenario: 載入歷史後續聊
- WHEN 使用者從歷史載入某 session 並送出新訊息
- THEN 該訊息以原 thread 的上下文繼續，且新內容寫回同一 rollout
