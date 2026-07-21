# edit-feedback

## ADDED Requirements

### Requirement: LSP 診斷回饋

write/apply_patch 之後，系統 SHALL 於語言伺服器取得該檔診斷，並把 severity-1（error）診斷以結構化區塊注回模型（每檔上限一定數量，並涵蓋因此變更而在其他檔案產生的錯誤）。

#### Scenario: 寫入產生語法錯誤

- WHEN 一次寫入使該檔產生 error 級診斷
- THEN 系統把該錯誤以 `<diagnostics>` 區塊注回模型，供其立即修正

### Requirement: 工具輸出磁碟溢出與可搜

工具輸出超過上限（行數/位元組）時，系統 SHALL 將完整輸出寫入磁碟並僅向模型呈現頭+尾預覽與「完整內容已存於 <path>」標記；grep 工具 SHALL 能搜尋這些溢出檔。

#### Scenario: 巨量工具輸出

- WHEN 工具輸出超過上限
- THEN 模型看到頭+尾預覽與存檔路徑，完整內容落磁碟，且可被 grep 搜尋

#### Scenario: 溢出檔保留清掃

- WHEN 溢出檔超過保留期（如 7 天）
- THEN 系統清掃過期溢出檔
