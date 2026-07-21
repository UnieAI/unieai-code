# context-compaction

## ADDED Requirements

### Requirement: 滾動結構摘要

Compaction SHALL 產出並維護單一份固定骨架的結構摘要，且後續壓縮以合併方式更新它，而非每次從完整歷史重新摘要。

骨架欄位固定為：Objective、Important Details、Work State（Completed / Active / Blocked）、Next Move、Relevant Files。摘要提示 SHALL 明令保留精確檔案路徑、符號名、指令字串與錯誤訊息的逐字內容。

#### Scenario: 第一次壓縮

- WHEN 一場對話首次觸發壓縮
- THEN 系統依骨架產出結構摘要，涵蓋目前為止的目標、關鍵細節、已完成／進行中／受阻的工作、下一步與相關檔案

#### Scenario: 後續壓縮以合併更新

- WHEN 已存在一份結構摘要且再次觸發壓縮
- THEN 系統以「保留仍為真、移除過時、併入新增」的指令改寫既有摘要，而非丟棄它重摘
- AND 先前摘要中仍成立的精確路徑／符號／指令／錯誤字串 SHALL 原樣保留

### Requirement: 逐字近況尾巴

除結構摘要外，系統 SHALL 保留最近一段不經摘要的逐字訊息，token 量以可設定的 `KEEP_TOKENS`（預設 8000）為上限。

#### Scenario: 分割保留邊界

- WHEN 壓縮計算「摘要以上／逐字保留以下」的分割點
- THEN 分割點 SHALL 精準命中 `KEEP_TOKENS` 預算，必要時允許在單一訊息內部切分
- AND 逐字尾巴 SHALL 原封不動附在結構摘要之後

### Requirement: 反應式 context 溢出恢復

除事前 token 預算檢查外，當 provider 於回應中回報 context 溢出錯誤時，系統 SHALL 就地觸發壓縮、以壓縮後歷史重建請求並重試該回合。

此恢復路徑 SHALL 帶單次防迴圈守衛：同一回合內只允許反應式壓縮一次；若壓縮後仍溢出，SHALL fail-safe 收尾（回報失敗）而非再次重試。

#### Scenario: 串流中回報 context 溢出

- WHEN provider 於回合進行中回報 context-overflow 類錯誤
- THEN 系統壓縮歷史、以壓縮結果重建請求並重試同一回合
- AND 使用者無需手動重送

#### Scenario: 防止壓縮風暴

- WHEN 某回合已做過一次反應式壓縮、重試後仍回報 context 溢出
- THEN 系統 SHALL 停止重試並以明確失敗結束該回合，不再進入下一次反應式壓縮

### Requirement: Two-pass 長歷史摘要

當待壓縮歷史超過單次摘要可靠處理的長度時，系統 SHALL 以兩段式摘要：先摘除約 95%（依 token 權重）為中間摘要，再以中間摘要加最近 ~5% 尾巴改寫成後繼可見的最終摘要。

#### Scenario: 歷史過長

- WHEN 待壓縮的歷史 token 量超過設定門檻
- THEN 系統先產生涵蓋前 ~95% 的中間摘要，再結合最近尾巴改寫為最終滾動摘要

### Requirement: 摘要輸入的工具輸出截斷

送入摘要器的工具輸出 SHALL 先截斷至上限（預設約 2000 字元），使單筆巨量工具輸出不致主導摘要成本或內容。

#### Scenario: 巨量工具輸出進入摘要

- WHEN 待摘要的歷史包含超過上限的單筆工具輸出
- THEN 該輸出在送入摘要器前被截斷至上限，其餘歷史正常摘要
