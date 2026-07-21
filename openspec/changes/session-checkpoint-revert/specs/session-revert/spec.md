# session-revert

## ADDED Requirements

### Requirement: 訊息邊界選擇性還原

回捲到某則訊息時，系統 SHALL 掃描其後所有 assistant 訊息、把每個被觸及的檔案映射回「該檔案第一次被修改之前」的快照 tree，並僅還原這些檔案。

#### Scenario: 回捲到某則訊息

- WHEN 使用者要求回捲到訊息 M
- THEN 系統收集 M 之後所有訊息觸及的檔案，將每個檔案還原到其第一次被改之前的內容，未被觸及的檔案不動

### Requirement: 三段可逆 revert

回捲 SHALL 以可逆的三段流程進行：`stage` 還原檔案並產出 diff 預覽、`clear` 撤銷該次還原、`commit` 定案並丟棄被回捲的訊息。

#### Scenario: 預覽後反悔

- WHEN 使用者 `stage` 一次回捲、檢視 diff 後決定不要
- THEN `clear` SHALL 把工作區還原成回捲前的狀態，且不丟棄任何訊息

#### Scenario: 預覽後定案

- WHEN 使用者 `stage` 後選擇 `commit`
- THEN 系統定案檔案還原並從對話丟棄被回捲的訊息

### Requirement: 三軸回捲

系統 SHALL 支援獨立控制「是否回捲檔案」與「回捲到哪則訊息」，使「只回檔案」「只回對話」「兩者都回」三種模式皆可達成。

#### Scenario: 只回對話不動檔案

- WHEN 使用者以 `files:false` 回捲到訊息 M
- THEN 系統丟棄 M 之後的訊息，但工作區檔案維持現狀

### Requirement: 衝突回報

回捲結果 SHALL 回傳已還原檔案、未變更檔案、以及無法乾淨還原的衝突清單（含路徑與衝突類型），供前端呈現。

#### Scenario: 檔案自回捲點後又被外部改動

- WHEN 某檔案在回捲點之後被 agent 以外的來源改動、無法乾淨還原
- THEN 該檔案 SHALL 出現在衝突清單中，附路徑與衝突類型，而非被靜默覆寫
