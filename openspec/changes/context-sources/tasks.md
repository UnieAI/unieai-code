# Tasks: context-sources

## 1. 研究對照
- [x] 1.1 讀 opencode system-context 概念；查證現況：`buildSystemPrompt` 支援 `now` 但 engine **沒傳**（日期從沒注入）；**無** AGENTS.md 探索

## 2. typed sources（agent-core）
- [x] 2.1 Source 介面（`{name, load()→{text}|null|throw}`；throw=暫時不可用）— `context-sources.mjs`
- [x] 2.2 system context 由 source 集合種 baseline（engine 建立時 resolve→seed epoch→注入）
- [x] 2.3 內建 sources：`dateSource`（注入 date，補既有 bug）、`agentsMdSource`（cwd→.git 根 + ~/.config/AGENTS.md，nearest-last）。保留 .codex 探索、未動 CLAUDE.md

## 3. epoch + delta
- [x] 3.1 per-session context epoch（`applyEpoch`；存進 session、resume 還原）
- [x] 3.2 source 改變 → 對話中 delta 注入（engine send() 前 re-resolve + `renderContextUpdate`；date rollover / AGENTS.md 替換語意；resume 時補 away-change）

## 4. 可用性語意
- [x] 4.1 暫時不可用（load throw）保留 baseline、不發 delta；removed 才撤除（`applyEpoch` 測試涵蓋）

## 5. 驗收
- [x] 5.1 單元：date baseline→update、AGENTS.md 探索/替換（context-sources.test.mjs 9 tests）
- [x] 5.2 單元：unavailable 不清空 context（測試涵蓋）
- [ ] 5.3 與 compaction 互動：AGENTS.md 以 user 訊息注入（compaction 保留邏輯待整合測試）
- [ ] 5.4 openspec validate + archive（實作完成、尚未 archive）
