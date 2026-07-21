# Tasks: session-render-web-share

> 進度註記（2026-07-22）：本輪聚焦 **webview 端渲染強化**（VS Code 面板），
> 參考 opencode session-ui 的渲染想法以純 JS/CSS 落地；未抽成獨立元件庫，
> web 分享（第 3 節）延後。變更範圍限 `sdks/vscode/`。

## 1. 研究對照
- [x] 1.1 讀 opencode `packages/session-ui/src/components/*`（session-turn、message-part、session-review、prompt-input）與 `context/data.tsx`（store 餵資料）— 作為渲染想法來源
- [ ] 1.2 讀 `packages/web/src/pages/s/[id].astro` + `Share.tsx`（SSR + 分享）— web 分享延後

## 2. 渲染元件庫
- [ ] 2.1 定義 session store 資料模型（對齊 transport-unified-sdk）— 延後
- [x] 2.2 強化渲染：工具卡（bash `$ cmd` + exit code badge + 可展開輸出、read/write/edit 檔案卡、失敗/進行中視覺、spinner）、markdown（程式碼區塊複製鈕）、每則訊息「複製為 Markdown」、串流游標與思考中 shimmer、reasoning 折疊優化、審批/提問卡片統一。（就地強化，未抽成獨立元件庫）
- [x] 2.3 VS Code 面板套用上述強化（後端 `agentCoreBackend.mapToolEvent` 補 `tool_name`/`status`；webview `commandExecutionBlock` 依工具分流渲染；production build + tsc 0 錯）

## 3. web 分享
- [ ] 3.1 唯讀 SSR 分享頁 + 分享連結
- [ ] 3.2 隱私邊界（公開範圍、唯讀保證）
- [ ] 3.3（後續）即時串流

## 4. 驗收
- [ ] 4.1 面板遷移後渲染回歸
- [ ] 4.2 分享連結唯讀呈現一致
- [ ] 4.3 openspec validate + archive
