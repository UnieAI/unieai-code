# Tasks: permissions-durable

> 落點：核准記憶做在 **agent-runtime**（unieai-code，包住 host 傳入的 requestApproval），agent-core 不動、Studio 無關。

## 1. 研究對照
- [x] 1.1 opencode 每專案規則/自動放行/save-on-approve 概念；查證現況：agent-runtime 無任何核准快取，`acceptForSession` 無記憶效果（bash 每次重問）
- [x] 1.2 arity 歸併：以「命令 + subcommand（已知多命令工具才含）」為簽名，取代 tree-sitter（輕量、保守）

## 2. 持久化規則
- [x] 2.1 專案層規則儲存 `approval-rules.mjs`：`ruleSignature` + `loadApprovals`/`saveApproval`（`UNIEAI_HOME/approvals/<projectKey>.json`）
- [x] 2.2 自動放行：engine 包 requestApproval，bash 升級時簽名命中 session set 或 durable store → 直接 accept 不再問；`acceptForSession` 存 session set（對應「本次對話都允許」按鈕）
- [ ] 2.2b durable「always」跨 session：機制已就緒（durable store），但需前端新增「永遠允許」按鈕才有觸發來源 —— 未做（前端）

## 3. 級聯與修正 — 未做
- [ ] 3.1 拒絕級聯（同 session 其他待審）— 需 approval flow 改造
- [ ] 3.2 帶訊息拒絕 → 模型可讀修正回饋（CorrectedError）— 需前端回帶訊息 + loop 配合

## 4. bash arity 歸併
- [x] 4.1 `ruleSignature`：`git log -n5 --oneline` 與 `git log` 同簽名；`git log` ≠ `git push`（不誤放行）；含 shell operator 的指令不歸併（fail-closed，防夾帶第二個命令）

## 5. 驗收
- [x] 5.1 單元：自動放行、acceptForSession 存 session（wrapper 冒煙驗證）
- [x] 5.2 單元：git log / git log -n5 歸併同規則、per-project 隔離（approval-rules.test.mjs 7 tests）
- [x] 5.3 安全：subcommand 保留避免 git push 被 git log 規則放行；shell operator 不歸併
- [ ] 5.4 openspec validate + archive（2.2b/§3 未做）
