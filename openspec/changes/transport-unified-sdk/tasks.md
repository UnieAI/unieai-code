# Tasks: transport-unified-sdk

Re-scoped against `design.md` + `design-notes/`. Research (§1) is done; the
implementation tasks now map to the 6-stage migration plan.

## 1. 研究對照 ✅ (done — see design-notes/)
- [x] 1.1 讀 opencode `server/routes.ts:53-61`(openapi via `HttpApiBuilder.layer`
  + `OpenApi.fromApi`), `sdk/js/script/build.ts:47-72`(@hey-api/openapi-ts),
  `sdk-next/src/opencode.ts:20-38`(同 router in-process via `toWebHandler` + fetch shim)
- [x] 1.2 盤點現有兩套傳輸並列差集 → `design-notes/inventory.md`
  (§A Rust app-server：panel 只用 6 requests / 4 server-requests / 15 notifs；
  §B JS engine send/steer/isBusy/setWebAccess/checkpoints/resume；§C 差異表)
- [x] 1.3 (new) 定義統一 surface 為可被 codegen 消費的實體 → `design-notes/api-surface.json`
- [x] 1.4 (new) 傳輸互換機制原型（embedded≡remote）→ `design-notes/prototype/` (runnable)

## 2. API surface 定義
- [x] 2.1 定義 session/turn 端點（prompt/interrupt/revert stage·commit·clear/
  history/permission reply/question reply/compact/web-access/events）→ 18 ops，
  見 `api-surface.json`（採 opencode `v2.session.*` 形狀）
- [ ] 2.2 產出 OpenAPI 生成管線：選定 authored-spec + CI 契約測試（router↔spec 一致），
  或改用可 emit OpenAPI 的 typed-route 框架（design.md D4 決策）
- [ ] 2.3 `openspec validate` 綁進 CI；spec 落 `sdk/js-unified/openapi.json`

## 3. 生成 SDK (Stage 1)
- [ ] 3.1 `@hey-api/openapi-ts` codegen（typescript + sdk + client-fetch 三 plugin，
  baseUrl/fetch 可覆寫）→ `sdk/js-unified`；加 opencode 式 patch-guard 防 codegen drift
- [ ] 3.2 VS Code extension 依賴生成 client（先與現行 app-server/agent-core 並存）

## 4. in-process 同 router (Stage 2)
- [ ] 4.1 實作 assembled router（plain-JS web handler）+ Backend A（engine.mjs adapter）+
  embedded fetch；SSE 事件 union 映射（onText/onToolEvent → SessionEvent）
- [ ] 4.2 行為等價性測試（內嵌 vs 網路）— 以 `prototype/equivalence.test.mjs` 為藍本，
  跑真後端

## 5. 後端收斂
- [ ] 5.1 (Stage 3) VS Code 面板新增 `unified` engine；webview 協定改為 SessionEvent 的
  render adapter；回歸後翻預設
- [ ] 5.2 (Stage 4) Backend B：先 JSON-RPC 橋接（b1），再 Rust 原生 host OpenAPI router（b2）
- [ ] 5.3 (Stage 5) 能力差異以 `/capabilities` 旗標表達；retire 雙 webview 橋接與手接 app-server client

## 6. 驗收
- [ ] 6.1 契約測試：同操作內嵌/網路等價 + 能力缺口統一回 501（兩後端共跑同一 suite）
- [ ] 6.2 VS Code 面板在 SDK 上功能回歸（含 fallback 保留）
- [ ] 6.3 openspec validate + archive
