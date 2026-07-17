# UnieAI Code VS Code 擴充 — UX Audit（2026-07-17）

自查清單。狀態：✅ 已修 / 🚧 待做 / 💡 提案。

## 已修（v0.8.0）
- ✅ **快捷鍵與 Claude Code 擴充相撞**：cmd+escape 與 cmd+alt+k 都是
  anthropic.claude-code 的預設鍵，同時觸發會打開對方的面板（用戶看到
  ~/.claude.json 內容且「關不掉的指令面板」即此因）。改為
  cmd+alt+u（開啟聊天）、cmd+alt+m（插入 @檔案）。
- ✅ 串流更新會重置工具輸出/思考區塊的展開狀態 → 重繪時保留使用者的
  展開/收合選擇。
- ✅ 強制捲到底部：使用者往上閱讀時會被拉回 → 只有原本就在底部附近才
  自動跟隨。
- ✅ 輸入框固定高度 → 隨內容自動長高（上限 160px）。
- ✅ 歷史面板只能點 ✕ 關閉 → Esc / 點擊遮罩皆可關閉。
- ✅ 空白聊天室沒有任何引導 → 加入置中提示「問我任何事，或輸入 / 使用指令」。

## 待做
- 🚧 互動式核准：exec 模式無法中途允許/拒絕指令（需改接 app-server 協定）。
- 🚧 diff 檢視：file_change 目前只列路徑，點開應顯示彩色 diff。
- 🚧 多工作區支援：僅使用第一個 workspace folder。
- 🚧 歷史清單無法搜尋/過濾、無法刪除 session。
- 🚧 turn.failed 之後缺少「重試」按鈕。
- 🚧 Stop 之後沒有明確的「已中斷」標記。

## 提案
- 💡 @ 檔案自動補全（輸入 @ 時列出工作區檔案）。
- 💡 訊息 hover 顯示複製按鈕（複製 markdown / 純文字）。
- 💡 model pill 顯示 context window 用量。
- 💡 reasoning 事件（gateway 修好 reasoning_content 映射後）以打字機
  效果即時顯示於折疊區。
