# scrollback-aggregation

## ADDED Requirements

### Requirement: 動詞群組時態聚合

連續的非破壞性工具呼叫 SHALL 折成單一摘要行，依工具種類分桶、名詞按數量複數化、依進行中/完成切換動詞時態，並在有失敗時附加失敗計數。

#### Scenario: 一連串唯讀工具

- WHEN agent 連續讀多個檔案並執行多次搜尋
- THEN scrollback 顯示一行如「Read 3 files, Searched 2 patterns」，進行中時為進行式，其中 1 次失敗則附「· 1 failed」

### Requirement: 來源去重

聚合計數 SHALL 對可辨識的來源去重：網頁搜尋依 citation URL、subagent 依 child-session-id。

#### Scenario: 重複來源

- WHEN 多次網頁搜尋命中相同 citation URL
- THEN 聚合計數對該來源去重，不重複計入

### Requirement: 釘頂回合標頭

Prompt SHALL 作為節標頭，於捲動超過時釘在頂端，並在下一個 prompt 逼近時被逐步推離頂端。

#### Scenario: 捲動長回合

- WHEN 使用者捲動超過某個 prompt
- THEN 該 prompt 釘在頂端；捲近下一個 prompt 時被推走
