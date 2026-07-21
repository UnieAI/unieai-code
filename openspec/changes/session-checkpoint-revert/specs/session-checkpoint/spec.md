# session-checkpoint

## ADDED Requirements

### Requirement: 影子 git 工作區快照

系統 SHALL 在每個回合步驟把工作區狀態快照進一個與使用者專案 `.git` 分離的獨立 git repo，快照識別以 git tree hash 表示，且此操作 SHALL NOT 修改使用者真實的 git 歷史、索引或工作區檔案。

#### Scenario: 一步產生一個快照

- WHEN agent 在一個回合中完成一步（含檔案修改）
- THEN 系統把當下工作區寫入影子 git repo 並記錄其 tree hash 為該步的快照 id
- AND 使用者專案的 `.git`（HEAD、index、工作樹）維持不變

#### Scenario: 快照排除大型衍生目錄

- WHEN 建立快照時工作區含被 ignore 的大型目錄（如 node_modules、target）
- THEN 這些目錄 SHALL 依 ignore 規則排除於快照之外，避免快照體積失控

### Requirement: Per-message 檔案足跡

Session SHALL 為每則 assistant 訊息記錄其觸及（新增／修改／刪除）的檔案清單，作為訊息邊界回捲的依據。

#### Scenario: 記錄修改足跡

- WHEN 一則 assistant 訊息透過工具修改了若干檔案
- THEN 系統記錄該訊息觸及的檔案路徑集合，可供後續回捲查詢
