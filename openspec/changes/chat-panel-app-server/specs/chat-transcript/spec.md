# chat-transcript

## ADDED Requirements

### Requirement: 逐字串流
Agent 回覆 SHALL 以 delta 逐字渲染於 transcript，thinking delta 即時進入折疊的「思考過程」區塊；渲染以動畫幀批次進行，不因高頻事件卡頓。

#### Scenario: 串流中閱讀
- WHEN agent 正在產生長回覆
- THEN 文字逐步出現且捲動僅在使用者位於底部附近時跟隨

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
