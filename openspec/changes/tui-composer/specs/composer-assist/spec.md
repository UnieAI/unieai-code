# composer-assist

## ADDED Requirements

### Requirement: 下一句 ghost 提示

回合結束後，系統 MAY 預測下一句 prompt 並以灰字顯示於空輸入框；其可見與否 SHALL 每次由當前輸入文字推導：文字相符則縮短提示、發散則隱藏、清空則回復。Tab（或行末 Right）SHALL 接受提示。

#### Scenario: 接受預測

- WHEN 空輸入框顯示 ghost 提示且使用者按 Tab
- THEN 提示文字填入輸入框

#### Scenario: 打字發散

- WHEN 使用者輸入與 ghost 提示不相符的文字
- THEN 提示隱藏；輸入清空後可再出現

### Requirement: 貼上與圖片 chip

大段貼上 SHALL 折成可展開的 `[Pasted N lines]` chip、貼上圖片 SHALL 折成 `[Image #N]` chip；chip 為輸入框內帶範圍的原子元素，編輯時範圍隨之位移，並能跨 stash/restore 存活，送出時展開為實際內容。

#### Scenario: 貼上大段文字

- WHEN 使用者貼上超過門檻的文字
- THEN 折成 `[Pasted N lines]` chip，可 Enter 展開回原文，送出時以原文送出

### Requirement: TTL 教學提示

輸入框上方 SHALL 可顯示單行情境教學提示，該提示於打字時不消失（僅由 TTL 或送出清除），且每 session 顯示達一定次數後不再出現。

#### Scenario: 提示達顯示上限

- WHEN 某提示在本 session 已顯示達上限次數
- THEN 該提示不再出現
