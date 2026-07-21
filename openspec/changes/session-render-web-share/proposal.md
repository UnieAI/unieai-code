# Proposal: session-render-web-share

**Target:** unieai-code（前端渲染 + web）· 來源：opencode `packages/session-ui`、`packages/web/src/pages/s/[id].astro`

## Why

「渲染一場對話」目前綁死在 VS Code webview 裡（chat.js），無法在別處重用，也**沒有 web 分享**這個能力。opencode 把渲染做成一套 **store 餵資料的獨立元件庫**（訊息／工具卡／diff／markdown／審閱／輸入框），同時餵 web 分享頁、桌面、VS Code。把渲染器抽成 library 是解鎖 web 分享與跨 client 一致呈現的前提。

## What Changes

- **store 餵資料的渲染元件庫**：把對話渲染（訊息、工具卡、diff、markdown、plan/subagent、審閱、輸入框）抽成獨立、以 store 為輸入的元件庫，不綁單一 client。
- **VS Code 面板改用該庫**：現行 chat.js 的渲染改建在元件庫上（行為回歸）。
- **web 分享頁**：以唯讀方式在 web 呈現一場 session（SSR 初載 + 即時串流可後續加），產生可分享連結。
- 建在 `transport-unified-sdk` 的 client surface 上——分享頁與面板讀同一份 session 資料模型。

## Capabilities

### New Capabilities
- `session-render`：store 餵資料的對話渲染契約（元件與資料模型分離、跨 client 重用）。
- `web-share`：唯讀 web session 檢視與分享連結。

## Impact

- **落點：unieai-code**：新增渲染元件庫、web 分享頁；VS Code 面板遷移到元件庫。
- 依賴 `transport-unified-sdk`（共用 session 資料模型）。
- 風險：分享的隱私邊界（哪些內容可公開、是否去識別化）需明確；先做唯讀 SSR，即時串流與權限交互後續。
