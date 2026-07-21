# command-palette

## ADDED Requirements

### Requirement: 統一命令面板

TUI SHALL 提供一個以單一 action registry 為來源的命令面板（Ctrl+P），該 registry 同時供應快捷列提示、按鍵派發與面板的模糊搜尋；選取需要參數的指令 SHALL 進入 arg-picker，且可退回面板。

#### Scenario: 開面板選指令

- WHEN 使用者按 Ctrl+P 並輸入關鍵字
- THEN 面板以模糊比對列出可執行的 action（含快捷提示），選取即執行

#### Scenario: 需要參數的指令

- WHEN 使用者於面板選取一個需要參數的指令（如切換模型）
- THEN 進入 arg-picker 選參數，且可退回面板重選
