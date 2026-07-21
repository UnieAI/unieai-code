# durable-permissions

## ADDED Requirements

### Requirement: 每專案持久化規則與自動放行

使用者選擇「always」核准時，系統 SHALL 把該 action 與 resource 樣式持久化為專案層規則，並自動放行後續已被該規則涵蓋的待審請求。

#### Scenario: always 核准後自動放行

- WHEN 使用者對某 action 選擇 always
- THEN 系統存下規則，且同 session 中已涵蓋的待審請求自動放行，無需再問

### Requirement: 拒絕級聯

拒絕同一 session 的某個待審請求時，系統 SHALL 級聯拒絕該 session 其他待審請求。

#### Scenario: 一次拒絕多個待審

- WHEN 某 session 有多個待審核准、使用者拒絕其一
- THEN 該 session 其他待審請求一併被拒絕

### Requirement: 拒絕即修正回饋

帶訊息的拒絕 SHALL 以模型可讀的修正回饋形式回傳，使模型可據以調整後續行為，而非直接中止。

#### Scenario: 帶訊息拒絕

- WHEN 使用者拒絕並附上說明訊息
- THEN 模型收到該說明作為可行動的修正，調整下一步，而非硬停

### Requirement: bash 指令 arity 歸併

bash 核准規則 SHALL 以歸併後的指令樣式儲存，使同一基礎指令的不同旗標共用一條規則。

#### Scenario: 同指令不同旗標

- WHEN 已對 `git log` 存過 always 規則、之後出現 `git log -n5`
- THEN 系統視為同一歸併樣式，沿用既有規則放行，不重複詢問
