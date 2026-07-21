# context-sources

## ADDED Requirements

### Requirement: Typed context sources

System context SHALL 由一組具 `load / baseline / update / removed` 生命週期的 typed source 組成，而非單一靜態字串。

#### Scenario: 組裝初始 context

- WHEN 一場對話開始
- THEN 系統載入各 source 的 baseline 組成初始 system context

### Requirement: 對話中 delta

當某 source 於對話進行中改變時，系統 SHALL 只送出該 source 的對話中 delta，而非重送整段 system context。

#### Scenario: 日期跨日

- WHEN 內建 date source 偵測到日期改變
- THEN 系統送出「今天日期改為…」的 delta，而非重送整段 prompt

#### Scenario: AGENTS.md 變更

- WHEN 專案 AGENTS.md 內容改變
- THEN 系統送出「以下取代先前所有指示」的更新，涵蓋新內容

### Requirement: 可用性語意

Source SHALL 區分「暫時不可用」與「已移除」：暫時不可用時 SHALL 保留上次成功的 baseline，不得以空值汙染 context；已移除時才將該 source 自 context 撤除。

#### Scenario: source 暫時失效

- WHEN 某 source 於載入時暫時失敗（非移除）
- THEN 系統保留該 source 上次成功的 baseline，不清空亦不報為移除
