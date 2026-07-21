# Proposal: session-checkpoint-revert

**Target:** unieai-agent-core（session/snapshot 服務，需 git 工作區）· 來源：opencode `packages/core/src/snapshot.ts`、`session/revert.ts`

## Why

現行迴圈沒有「把工作區回到某個對話點」的能力——只有 context compaction，沒有檔案層的檢查點。使用者要撤銷 agent 的一連串修改，只能靠 git 手動處理，且無法連同對話一起回捲。opencode 的做法乾淨：每一步把工作區快照進一個**獨立的影子 git repo**（用 git tree hash 當快照 id，完全不碰使用者真實的 git 歷史），回捲時把每個被動過的檔案映射回「它第一次被改之前」的 tree 選擇性還原，而且回捲是**三段可逆預覽**（stage→預覽 diff→commit 或 clear 反悔）。

## What Changes

- **影子 git 快照**：每個回合步驟把工作區狀態寫進 `$data/snapshot/<project>/<hash(worktree)>` 的獨立 git repo；快照 id 是 tree hash，使用者的真實 `.git` 完全不受影響。
- **訊息邊界回捲**：回捲到某則訊息時，掃描其後所有 assistant 訊息、把每個被觸及的檔案映射回「第一次被修改之前」的 tree，選擇性還原。
- **三段可逆 revert**：`stage`（還原檔案 + 算出 diff 預覽）→ `clear`（撤銷這次還原）→ `commit`（定案並丟棄被回捲的訊息）。
- **三軸**：`files:true/false` × 訊息回捲，讓「只回檔案」「只回對話」「兩者都回」三種都成立。
- 回傳結構含 `reverted_files` / `clean_files` / 衝突清單，供前端（TUI Esc-Esc 回捲、VS Code）呈現。

## Capabilities

### New Capabilities
- `session-checkpoint`：每步影子 git 快照的建立與定址（tree hash id、不碰真實 git）。
- `session-revert`：訊息邊界的選擇性檔案還原、三段可逆 stage/clear/commit、三軸回捲、衝突回報。

## Impact

- **落點：unieai-agent-core**：新增 snapshot 服務（spawn git plumbing against a shadow git dir）、revert 服務、以及對外 API（供 CLI/VS Code 呼叫）。
- **搭配 unieai-code**：TUI 的 Esc-Esc 三軸回捲 picker 是本能力的前端（另立 change `tui-rewind`）。
- 前置需求：session 需能列舉「每則 assistant 訊息觸及了哪些檔案」——若現行 session 未記錄，需一併補上 per-message 檔案足跡。
- 風險：影子 git 對大型工作區的快照成本；需要 ignore 規則（node_modules/target 等）避免快照爆量。
