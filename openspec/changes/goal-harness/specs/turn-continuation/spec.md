# turn-continuation

## ADDED Requirements

### Requirement: 兩層獨立續跑閘門

回合完成續跑 SHALL 由兩個獨立機制構成，各有預算：goal round-end 續跑（注入 goal 續跑指令）與 stop-hook gate（注入 stop-hook 回饋，每回合上限 8 次）。兩者順序評估、包在取樣迴圈外。

#### Scenario: goal 續跑

- WHEN 回合結束且 goal 判定仍需推進
- THEN goal round-end 注入續跑指令，回合繼續

#### Scenario: stop-hook 上限

- WHEN stop-hook gate 於同一回合已注入回饋達 8 次
- THEN 不再注入，回合收尾，避免無限續跑

### Requirement: 完成閘門

完成判定 SHALL 由 verifier 與多角色 goal 樂團共同決定，而非單一 skeptic 驗證呼叫。既有的「未改檔→mutation nudge」「有改檔→skeptic 缺口重播」行為保留，作為 verifier 角色的行為並於此明文化。

#### Scenario: 宣稱完成但未改檔

- WHEN 模型宣稱完成但工作區無變更且任務需要變更
- THEN verifier 發出 mutation nudge 要求實作，goal 不判定為完成

#### Scenario: 有改檔則嚴格審查

- WHEN 工作區已變更且模型宣稱完成
- THEN verifier 以 diff＋任務嚴格審查，非 ACHIEVED 則注入可行動缺口，並可升級至 strategist
