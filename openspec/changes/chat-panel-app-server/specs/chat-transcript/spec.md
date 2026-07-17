# chat-transcript

## ADDED Requirements

### Requirement: 串流粒度跟隨協定
Transcript SHALL 以 app-server 協定原生事件粒度渲染（有 delta 就 delta、只有 item 更新就 item 級），不自行切分或聚合語意；thinking 內容進入折疊的「思考過程」區塊。

#### Scenario: 串流中閱讀
- WHEN agent 正在產生長回覆且協定送出 AgentMessageDelta
- THEN 文字隨 delta 出現，捲動僅在使用者位於底部附近時跟隨

### Requirement: 計畫（Todo）清單
Agent 的計畫更新 SHALL 以計畫卡（☐/☑ 清單）呈現並隨 PlanDelta 就地更新，不新增重複卡片。

#### Scenario: 計畫項目完成
- WHEN agent 將某計畫項目標記完成
- THEN 既有計畫卡上該項目由 ☐ 變 ☑，卡片位置不變

### Requirement: Subagent 顯示
Subagent 子 thread 的活動 SHALL 以巢狀卡片顯示於觸發它的位置（標示名稱與狀態），其內部工具活動摺疊於卡片內，不與主 thread 的項目混排。

#### Scenario: subagent 執行中
- WHEN 主 thread 啟動一個 subagent
- THEN transcript 出現該 subagent 的巢狀卡（執行中狀態），完成後顯示摘要，展開可見其步驟

### Requirement: Tool card 對齊 TUI
工具卡 SHALL 與 TUI 呈現相同的資訊結構：`$ 指令`列、狀態符號、exit code、輸出預設摺疊（失敗自動展開）、diff 配色與 TUI 一致。

#### Scenario: 指令成功與失敗
- WHEN 指令成功
- THEN 顯示與 TUI 相同的成功樣式且輸出摺疊；WHEN 失敗 THEN 紅色標示、exit code、輸出自動展開

### Requirement: 雜訊過濾
非任務相關的診斷訊息（如 resume 時的 model 不一致提醒）SHALL NOT 進入 transcript。

#### Scenario: 跨模型 resume
- WHEN 使用者以不同模型接續歷史 session
- THEN transcript 不顯示 model 不一致警告，回合正常執行

### Requirement: Diff 檢視
檔案修改 SHALL 以行級著色的 unified diff 呈現（新增綠、刪除紅），檔名可點擊並在編輯器中開啟對應檔案。

#### Scenario: 檢視並開啟變更
- WHEN agent 修改了檔案且事件附帶 diff
- THEN transcript 顯示著色 diff；點擊檔名後該檔在編輯器分頁開啟

#### Scenario: 無 diff 資料
- WHEN 事件僅含變更路徑清單
- THEN 退回 +/-/~ 路徑清單顯示

### Requirement: 回合終態
回合中斷或失敗 SHALL 有明確視覺標記；失敗時提供「重試」按鈕，重試以相同輸入與設定重新送出。

#### Scenario: 使用者中斷
- WHEN 使用者按下停止
- THEN transcript 插入「已中斷」標記列，輸入框立即可用

#### Scenario: 回合失敗後重試
- WHEN 回合以錯誤結束
- THEN 錯誤列旁出現「重試」，點擊後以同一則使用者訊息重跑並沿用 thread
