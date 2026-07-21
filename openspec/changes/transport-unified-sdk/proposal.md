# Proposal: transport-unified-sdk

**Target:** unieai-code（產品/傳輸架構）· 來源：opencode `packages/server`、`packages/sdk`、`packages/sdk-next`

## Why

現在 client 與後端之間有**兩套不同傳輸**：VS Code 面板走 Rust app-server 的 JSON-RPC，或走 in-process JS agent-core loop——兩條路的介面、事件、錯誤處理都不一樣，每加一個功能都要在兩邊各接一次。opencode 的解法是：**一份 API 定義 → 生成 OpenAPI spec → 生成型別化 SDK**，而且 in-process 版本**跑同一個組裝好的 router、只是不開網路埠**。於是「內嵌 vs 遠端」只是換 transport，不是換協定。

## What Changes

- **單一 API 定義**：把 session/turn 相關操作（prompt / interrupt / revert(stage/commit/clear) / history / permission reply / question reply / compact …）定義為單一 API surface，並產出 `openapi.json`。
- **生成 SDK**：由 spec 自動生成型別化 client，所有 client（VS Code、未來 web、CLI slim）共用同一 client surface。
- **in-process 同 router**：提供一個「不開網路埠、直接在記憶體執行同一組 routing/middleware/handlers」的內嵌 client，讓內嵌與遠端行為一致。
- 目標是**把現有雙傳輸收斂到一個 client surface**；Rust app-server 與 JS loop 成為同一 API 的兩個後端實作，而非兩套協定。

## Capabilities

### New Capabilities
- `unified-transport`：單一 API surface 的端點契約、OpenAPI 生成、in-process 同-router 內嵌 client 與網路 client 的行為等價性。

## Impact

- **落點：unieai-code**（產品/infra，跨 Rust 與 JS）：定義 API、生成管線、in-process router 執行器；VS Code extension 改用生成 SDK。
- 大工程、跨語言，建議先定義 API 與生成 spec，再逐步把 VS Code 面板遷到 SDK，最後收斂 Rust/JS 後端。
- 收益：新功能只接一次；`session-render-web-share` 直接建在這個 client surface 上。
- 風險：Rust app-server 與 JS loop 的能力差異需在 API 層對齊（或以 capability 旗標表達）。
