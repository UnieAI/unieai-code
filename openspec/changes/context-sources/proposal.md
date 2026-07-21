# Proposal: context-sources

**Target:** unieai-agent-core（system context 組裝）· 來源：opencode `packages/core/src/system-context/`、`session/context-epoch.ts`、`instruction-context.ts`

## Why

現行系統提示是一坨靜態組好的字串。當某個上下文事實在對話中途改變（日期跨日、AGENTS.md 被改、某資訊源暫時失效），只能整段重送或不更新。opencode 的做法是把 context 拆成**一組有版本的 typed source**，每個 source 只在改變時送出**對話中 delta**，而且能區分「暫時不可用」（保留上次值）與「已移除」。

## What Changes

- **typed context sources**：每個 source 有 `load / baseline / update / removed` 生命週期；system context 由這些 source 組成，而非單一靜態字串。
- **context epoch + delta**：per-session 持久化一份 context 快照（epoch）；source 改變時只送「對話中 delta」——例如日期 source 送「今天日期改為…」而不重送整段 prompt。
- **可用性語意**：source 回報「暫時不可用」時保留上次成功值（baseline），與「已移除」區分，避免不穩定 source 汙染 context。
- **AGENTS.md 探索**：cwd→專案根 + `~/.config/AGENTS.md`，變更時重送「這些取代先前所有指示」。（保留現行 `.codex/` 探索；本 change 不動 CLAUDE.md。）

## Capabilities

### New Capabilities
- `context-sources`：typed source 生命週期、context epoch 快照與 mid-conversation delta、可用性（暫時不可用 vs 移除）語意、AGENTS.md 探索與替換語意。

## Impact

- **落點：unieai-agent-core**：system prompt 組裝改為 source 集合；新增 epoch 持久化與 delta 產出。
- 與 compaction 互動：compaction 全程保留 AGENTS.md／instruction source（如同 codex 現行行為）。
- 風險：delta 注入時機與 provider cache 斷點（見 provider-hardening）互動——source 變動不應無謂打斷 cache。
