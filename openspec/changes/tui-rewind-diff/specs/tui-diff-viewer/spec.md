# tui-diff-viewer

## ADDED Requirements

### Requirement: 全螢幕 diff 檢視器

TUI SHALL 提供全螢幕 diff 檢視器，支援 split/unified 切換、檔案樹、hunk 跳轉、標記已審閱，以及來源切換（工作區 / main 分支 / 上一回合）。

#### Scenario: 審閱一組變更

- WHEN 使用者開啟 diff 檢視器
- THEN 可切換 split/unified、於檔案樹與 hunk 間跳轉、把檔案標記為已審閱

#### Scenario: 切換比較來源

- WHEN 使用者切換 diff 來源
- THEN 檢視器改以「工作區 / main 分支 / 上一回合」為基準重新呈現差異
