# theme-system

## ADDED Requirements

### Requirement: JSON 主題定義與探索分層

主題 SHALL 以 JSON 定義，支援語意角色、對其他 def/role 的 ref、ANSI 號、dark/light 變體物件與 transparent sentinel；主題探索 SHALL 分層合併（內建 < 使用者設定 < 專案 < cwd）並支援 live reload。

#### Scenario: 使用者自訂主題覆蓋

- WHEN 使用者於設定目錄放一個同名主題 JSON
- THEN 該定義覆蓋內建同名主題，且變更後可即時重載

### Requirement: 從終端生成 system 主題

系統 SHALL 能從終端自身的 16 色即時衍生一整套主題（灰階 ramp、柔化文字、染色 diff 底），作為「system」主題。

#### Scenario: 選用 system 主題

- WHEN 使用者選擇 system 主題
- THEN 系統依當前終端 16 色調色板衍生完整主題

### Requirement: 色彩層級量化與背景偵測

系統 SHALL 偵測終端色彩層級（None/Basic/Ansi256/TrueColor）並把任意 RGB 降級到最佳可用層級，且 SHALL 以 OSC11 偵測終端背景色以自動選擇 dark/light；兩者皆 SHALL 可經環境變數覆寫。

#### Scenario: 256 色終端

- WHEN 在僅支援 256 色的終端執行
- THEN 主題色被量化到 Ansi256，而非送出不被支援的 truecolor
