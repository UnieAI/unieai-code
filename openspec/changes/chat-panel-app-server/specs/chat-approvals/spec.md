# chat-approvals

## ADDED Requirements

### Requirement: 互動核准卡片
在「預設權限」模式下，agent 的指令執行與檔案修改請求 SHALL 以核准卡片進入 transcript，提供「允許一次」「本次對話都允許」「拒絕」三個動作，且回合在使用者決定前保持等待狀態。

#### Scenario: 允許一次
- WHEN agent 請求執行 shell 指令且使用者點「允許一次」
- THEN 指令執行並以工具行顯示結果，後續相同指令仍需再次核准

#### Scenario: 本次對話都允許
- WHEN 使用者對某核准請求點「本次對話都允許」
- THEN 該類請求於同一對話後續自動放行；開新對話後恢復詢問

#### Scenario: 拒絕
- WHEN 使用者點「拒絕」
- THEN agent 收到拒絕並繼續回合（得改採其他做法或說明），transcript 保留該卡片的「已拒絕」狀態

### Requirement: 隱藏面板時的核准提醒
核准請求到達而聊天面板不可見時，extension SHALL 以 VS Code 通知提醒並允許直接在通知上核准或拒絕。

#### Scenario: 面板隱藏時收到請求
- WHEN 核准請求到達且 webview 不可見
- THEN 顯示帶「允許 / 拒絕」按鈕的 VS Code 通知，點擊後行為與卡片一致

### Requirement: 權限模式映射
權限膠囊 SHALL 映射為 sandbox 與 approval policy 組合：預設權限 = workspace-write + on-request；唯讀與規劃 = read-only + never；完全存取 = danger-full-access + never。

#### Scenario: 唯讀模式不彈核准
- WHEN 權限為「唯讀」或模式為「規劃」
- THEN 不出現核准卡片，寫入類操作直接被 sandbox 拒絕
