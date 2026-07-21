# edit-safety

## ADDED Requirements

### Requirement: 內容雜湊陳舊守衛

編輯或寫入檔案前，系統 SHALL 確認檔案當前內容仍等於工具讀取當時的內容；若已改變，SHALL 拒絕寫入並要求模型重讀後再編輯，而非覆寫。

#### Scenario: 檔案在核准後被改動

- WHEN 檔案於編輯核准後、寫入前被外部改動
- THEN 系統回報「檔案被改過，重讀再編輯」並不寫入

### Requirement: BOM 與換行保真

編輯 SHALL 保留檔案原有的 UTF-8 BOM 與換行風格，避免產生整檔假 diff。

#### Scenario: 編輯 CRLF 檔案

- WHEN 編輯一個使用 CRLF 換行（或帶 BOM）的檔案
- THEN 未變更的行維持原換行與 BOM，diff 僅顯示實際變更

### Requirement: 外部目錄核准閘

對工作區外的絕對路徑進行修改，SHALL 需要一道與一般編輯核准分離的 `external_directory` 核准。

#### Scenario: 寫入工作區外路徑

- WHEN 工具要寫入工作區根以外的絕對路徑
- THEN 系統要求獨立的 external_directory 核准，未核准則不寫入
