# Tasks: session-render-web-share

## 1. 研究對照
- [ ] 1.1 讀 opencode `packages/session-ui/src/components/*`（session-turn、message-part、session-review、prompt-input）與 `context/data.tsx`（store 餵資料）
- [ ] 1.2 讀 `packages/web/src/pages/s/[id].astro` + `Share.tsx`（SSR + 分享）

## 2. 渲染元件庫
- [ ] 2.1 定義 session store 資料模型（對齊 transport-unified-sdk）
- [ ] 2.2 抽出元件：訊息／工具卡／diff／markdown／plan·subagent／審閱／輸入框
- [ ] 2.3 VS Code 面板改用元件庫（行為回歸）

## 3. web 分享
- [ ] 3.1 唯讀 SSR 分享頁 + 分享連結
- [ ] 3.2 隱私邊界（公開範圍、唯讀保證）
- [ ] 3.3（後續）即時串流

## 4. 驗收
- [ ] 4.1 面板遷移後渲染回歸
- [ ] 4.2 分享連結唯讀呈現一致
- [ ] 4.3 openspec validate + archive
