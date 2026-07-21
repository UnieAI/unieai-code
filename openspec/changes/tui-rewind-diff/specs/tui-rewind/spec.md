# tui-rewind

## ADDED Requirements

### Requirement: Esc-Esc 回捲 picker

閒置且輸入框為空時，連按兩次 Esc SHALL 開啟回捲 picker。每個回捲點 SHALL 顯示 prompt 預覽、檔案快照數與是否有檔案變更；套用回捲 SHALL 呈現還原結果與衝突，並支援三軸（只對話／只檔案／全回）模式切換。回捲套用前 SHALL 可預覽。

#### Scenario: 開回捲 picker

- WHEN 使用者在閒置、空輸入框狀態連按兩次 Esc
- THEN 開啟回捲 picker，列出各回捲點與其 prompt 預覽、快照數、變更旗標

#### Scenario: 套用前預覽與衝突

- WHEN 使用者選一個回捲點並選擇模式
- THEN UI 呈現將還原的檔案與任何衝突，使用者確認後才套用

### Requirement: /jump 即時預覽導航

系統 SHALL 提供列出各回合的 /jump 導航，游標移動時即時捲動 transcript 到對應回合，Enter 定位，Esc 以寬度穩定的 anchor 還原開啟前的視窗。

#### Scenario: 瀏覽回合

- WHEN 使用者在 /jump 中上下移動游標
- THEN transcript 即時捲到游標所指回合；Esc 還原原本視窗位置
