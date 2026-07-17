# Tasks: chat-panel-app-server

## 1. 協定盤點（前置，不寫產品碼）
- [x] 1.1 讀 `codex-rs/app-server-protocol/src`，記錄 initialize / thread 生命週期 / user turn 方法與 payload
- [x] 1.2 記錄核准相關 server→client request 形狀（exec approval、patch approval）與回覆格式
- [x] 1.3 記錄串流通知（AgentMessageDelta、ReasoningTextDelta、CommandExecutionOutputDelta、PlanDelta 等）
- [x] 1.4 記錄 subagent 子 thread 事件（ThreadSource::Subagent、parent id、其項目如何路由）
- [x] 1.5 用 `unieai app-server` + 手寫 stdio 腳本跑通最小握手（initialize → thread → 一句話 → 回應），存 `design-notes/protocol-inventory.md`

## 2. AppServerClient（extension host）
- [x] 2.1 stdio JSON-RPC framing（Content-Length 或 line-delimited，依盤點）＋ request/response correlation
- [x] 2.2 process 生命週期：spawn、health、crash 偵測、deactivate 清理
- [x] 2.3 thread 管理：start / resume（歷史載入接同一 thread id）
- [x] 2.4 server→client 核准 request 的分發與回覆
- [x] 2.5 exec fallback 降級開關與一次性 notice

## 3. webview 協定 v2 與渲染
- [x] 3.1 訊息協定 v2（turnDelta / itemUpsert / approvalRequest / turnState / approvalReply / retry）
- [x] 3.2 delta 緩衝渲染（rAF 批次），thinking delta 進折疊區
- [x] 3.3 核准卡片 UI：允許一次 / 永遠允許（session）/ 拒絕，逾時顯示
- [ ] 3.4 diff 渲染（行級著色，配色對齊 TUI）＋ 點擊開檔（openFile）
- [ ] 3.4b tool card 資訊結構對齊 TUI（$ 指令列、exit code、輸出折疊、狀態符號）
- [ ] 3.4c PlanDelta → 計畫卡即時更新；subagent 子 thread 以巢狀卡顯示
- [x] 3.4d 雜訊過濾：resume 時的 model 不一致警告不進 transcript
- [x] 3.5 turnState：已中斷標記、失敗＋重試按鈕
- [x] 3.6 webview 隱藏時的核准提醒（badge + notification 按鈕）

## 4. 驗收
- [x] 4.1 冒煙：登入 → 提問 → 需核准的指令 → 允許 → diff → 開檔 → 重試 → 中斷 → 歷史 resume
- [ ] 4.2 降級測試：把 executablePath 指到不支援的 binary，確認 fallback 與 notice
- [ ] 4.3 中文 IME、上網開關、模型記憶回歸測試
- [ ] 4.4 openspec validate + archive
