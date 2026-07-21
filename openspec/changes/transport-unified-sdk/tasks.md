# Tasks: transport-unified-sdk

## 1. 研究對照
- [ ] 1.1 讀 opencode `packages/server/src/routes.ts:54`（openapi.json 生成）、`sdk/js/script/build.ts`、`sdk-next/src/opencode.ts`（同 router in-process）
- [ ] 1.2 盤點現有兩套傳輸：Rust app-server JSON-RPC 方法 vs VS Code in-process loop 介面，列出對應端點差集

## 2. API surface 定義
- [ ] 2.1 定義 session/turn 端點（prompt/interrupt/revert stage·commit·clear/history/permission reply/question reply/compact）
- [ ] 2.2 產出 OpenAPI 規格 + 生成管線

## 3. 生成 SDK
- [ ] 3.1 由規格生成型別化 client
- [ ] 3.2 VS Code extension 改用生成 SDK（先與現行並存）

## 4. in-process 同 router
- [ ] 4.1 不開埠、記憶體執行同一 router 的內嵌 client
- [ ] 4.2 行為等價性測試（內嵌 vs 網路）

## 5. 後端收斂
- [ ] 5.1 Rust app-server / JS loop 對齊為同一 API 的兩個後端；能力差異以 capability 旗標表達

## 6. 驗收
- [ ] 6.1 契約測試：同操作內嵌/網路等價
- [ ] 6.2 VS Code 面板在 SDK 上功能回歸
- [ ] 6.3 openspec validate + archive
