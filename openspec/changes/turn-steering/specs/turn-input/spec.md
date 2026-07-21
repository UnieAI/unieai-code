# turn-input

## ADDED Requirements

### Requirement: 單流回合協調

系統 SHALL 以 session key 序列化該 session 的回合執行，允許不同 session 併行；對同一 session 在有進行中 run 時再次要求執行，SHALL 併入既有 run 而非另起第二個。

#### Scenario: 同 session 重入

- WHEN 某 session 已有進行中的 run，收到對同 session 的新執行請求
- THEN 系統併入既有 run，不啟動第二個並行 run

#### Scenario: 不同 session 併行

- WHEN 兩個不同 session 同時要求執行
- THEN 兩者可併行，不互相阻塞

### Requirement: Steer 回合中轉向

系統 SHALL 支援把使用者插話折進**當前**回合（steer），並在折入時把該回合的剩餘步數預算重設為 1，使模型立即就轉向作出回應。

#### Scenario: 回合進行中插話

- WHEN 使用者在回合進行中送出 steer 訊息
- THEN 該訊息併入當前回合，步數預算重設為 1，模型下一步即回應轉向，而非等回合結束或中斷重送

### Requirement: Queue 排隊後續

系統 SHALL 支援排隊後續 prompt（queue），由外層迴圈於當前回合結束後依序 drain。

#### Scenario: 連續送出多則

- WHEN 使用者於回合進行中再送一則標為 queue 的 prompt
- THEN 該 prompt 不打斷當前回合，於當前回合結束後依序執行
