# session-render

## ADDED Requirements

### Requirement: Store 餵資料的渲染元件庫

對話渲染 SHALL 以一套獨立元件庫實作，其輸入為一份 session 資料 store，元件與資料模型分離，使同一套元件可被 VS Code 面板、web 分享頁等多個 client 重用。

#### Scenario: 面板以元件庫渲染

- WHEN VS Code 面板渲染一場對話
- THEN 面板使用共用元件庫，餵入 session store，得到訊息／工具卡／diff／markdown 等呈現

#### Scenario: 另一 client 重用同元件

- WHEN web 分享頁渲染同一場對話
- THEN 使用相同元件庫與資料模型，呈現與面板一致
