# unified-transport

## ADDED Requirements

### Requirement: 單一 API surface 與 OpenAPI 生成

Session/turn 操作 SHALL 定義為單一 API surface 並產出 OpenAPI 規格；所有 client SHALL 由該規格生成的型別化 SDK 存取後端，而非各自手寫協定。

#### Scenario: 新增一個端點

- WHEN 在 API surface 新增或修改一個操作
- THEN OpenAPI 規格與生成的 SDK 隨之更新，所有 client 透過同一 SDK 取得該操作，無需各 client 手動接線

### Requirement: In-process 同-router 內嵌

系統 SHALL 提供一個不開網路埠、在記憶體執行同一組 routing/middleware/handlers/codecs 的內嵌 client，其行為 SHALL 與網路 client 等價（相同路由、錯誤、編解碼）。

#### Scenario: 內嵌與遠端行為一致

- WHEN 同一操作分別以內嵌 client 與網路 client 呼叫
- THEN 兩者經過相同的 routing/handlers，回傳等價結果與錯誤語意

#### Scenario: 內嵌與遠端可互換

- WHEN client 從內嵌切換為連遠端後端（或反之）
- THEN 僅 transport 改變，client 使用的 API surface 不變
