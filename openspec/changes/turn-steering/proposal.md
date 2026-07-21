# Proposal: turn-steering

**Target:** unieai-agent-core（迴圈輸入與收尾控制）· 來源：opencode `session/run-coordinator.ts`、`session/input.ts`、`runner/max-steps.ts`、`question.ts`

## Why

現行 `runAgentLoop` 是線性的：一則 prompt 跑到完，中途插話只能中斷後重送（丟失當前回合進度）；步數到頂是硬截斷；模型要向使用者澄清只能借用權限管道。opencode 有三個乾淨的原語補上這些缺口：一個 ~80 行的**單流協調器**、兩種**回合中輸入投遞**（steer/queue）、**優雅的步數降級**、以及與權限分開的**結構化提問**。

## What Changes

- **單流協調器**：以 session key 序列化執行；不同 session 併行；對同一 session 重入時 `run()` **併入**進行中的 run 而非開第二個；`wake()` 只登記一個**合併**的後續；`interrupt()` 停止並等清理；成功且有待處理 wake 時**直接接續下一次 drain**。
- **steer（回合中轉向）**：插話折進**當前**回合，且把步數預算重設為 1（讓模型立即回應轉向）。
- **queue（排隊後續）**：後續 prompt 依序由外層迴圈 drain。
- **優雅 max-steps 降級**：步數上限為 per-agent、無全域硬上限；到最後一步時卸掉工具、`toolChoice:none`、注入強提示逼模型輸出「做了什麼＋剩什麼＋下一步」的純文字摘要，而非做到一半截斷。
- **結構化提問原語**：與權限分開的 `question` 工具（多選、可含自填選項），阻塞等使用者選擇、回傳標籤、**永不儲存**；被略過等同拒絕的權限（中止迴圈）。

## Capabilities

### New Capabilities
- `turn-coordinator`：單流執行、併入、合併 wake、中斷、接續 drain。
- `turn-input`：steer（折進當前回合、重設步數）與 queue（排隊後續）兩種投遞語意。
- `turn-degradation`：per-agent 步數上限與到頂時的強制摘要收尾。
- `elicitation-question`：結構化提問原語（多選、阻塞、不儲存、略過即中止）。

## Impact

- **落點：unieai-agent-core**：`loop.mjs`（協調器、steer/queue、max-steps 收尾）、新增 question 工具與提問通道。
- **搭配 unieai-code**：`question` 在 CLI 呈現為選單、在 VS Code 呈現為澄清卡片（前端渲染，跨 client 共用同一原語）。
- 風險：steer 重設步數為 1 需與 completionCheck/goal 續跑互動良好（轉向後不該被完成閘門誤判收工）。
