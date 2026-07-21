# turn-degradation

## ADDED Requirements

### Requirement: 優雅的步數上限降級

步數上限 SHALL 為 per-agent 設定、無全域硬上限。當回合抵達步數上限時，系統 SHALL NOT 直接截斷，而是卸除工具、將 `toolChoice` 設為不呼叫工具、並注入提示要求模型輸出「已完成事項＋剩餘事項＋下一步」的純文字摘要作為該回合結尾。

#### Scenario: 抵達步數上限

- WHEN 回合用盡 per-agent 步數上限
- THEN 系統於最後一步卸掉工具、強制純文字，模型輸出工作摘要與後續建議，而非在動作中途被截斷
