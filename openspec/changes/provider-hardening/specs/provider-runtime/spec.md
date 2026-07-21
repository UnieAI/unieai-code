# provider-runtime

## ADDED Requirements

### Requirement: Per-model 工具 schema 投影

送給模型的工具 JSON schema SHALL 依目標 model 的相容性投影成該 provider 可接受的形狀，且此投影 SHALL 只改變 wire 表述、不改變工具語意。

#### Scenario: gemini 目標

- WHEN 對 gemini 相容模型送出工具定義
- THEN 系統移除 `additionalProperties`、對 enum 作必要型別轉換後再送

#### Scenario: openai 目標

- WHEN 對 openai 相容模型送出工具定義
- THEN 系統攤平 `anyOf`、強制 `additionalProperties:false` 後再送

### Requirement: 小模型自動挑選

系統 SHALL 從模型目錄自動挑選一個低成本模型供摘要／壓縮等輔助呼叫使用，挑選以成本與新舊加權評分並輔以名稱樣式（nano/flash/lite/mini/haiku/small/fast）比對。目錄 SHALL 以磁碟快取（TTL 過期刷新、含內建 fallback）避免每次網路查詢。

#### Scenario: 壓縮呼叫挑便宜模型

- WHEN 系統需要一次摘要/壓縮輔助呼叫
- THEN 選用自動挑出的低成本模型，而非當前主模型

### Requirement: Retry 矩陣

重試 SHALL：尊重 `Retry-After`，否則帶 jitter 的有上限指數退避；以 typed HTTP 狀態分類可重試性，且 429 有獨立的低重試上限；context 溢出一律不重試（交由迴圈的溢出恢復處理）；對特定含圖片的失敗改以「移除圖片後重試」；空回應時記錄 had_reasoning/finish_reason/completion_tokens 以利診斷。

#### Scenario: 429 帶 Retry-After

- WHEN provider 回 429 且帶 Retry-After
- THEN 系統依 Retry-After 等待後重試，且 429 有獨立低重試上限

#### Scenario: 含圖片請求失敗

- WHEN 某含圖片的請求遭遇可重試但疑似與圖片相關的失敗
- THEN 系統以移除圖片後的請求重試，而非直接失敗
