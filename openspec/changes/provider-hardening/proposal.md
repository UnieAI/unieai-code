# Proposal: provider-hardening

**Target:** unieai-agent-core（provider/model 層）· 來源：opencode `packages/llm/src/protocols/utils/tool-schema.ts`、`cache-policy.ts`、`packages/core/src/catalog.ts`、`models-dev.ts`、`route/executor.ts`；grok-build `xai-grok-sampler/src/retry.rs`

## Why

Gateway 上跑各家開源與商用模型，工具呼叫的相容性差異是真實痛點：不同 provider 對 JSON schema 的接受度不同（gemini 不吃 `additionalProperties`、openai 要 `anyOf` 攤平），造成 tool-call 破圖。此外我們沒有便宜模型自動挑選（摘要／壓縮用大模型是浪費），cache 斷點也沒有自動佈點。這些都是 provider 層可攜的硬化。

## What Changes

- **per-model tool-schema 投影**：依 `model.compatibility` 把工具 JSON schema 投影成該 provider 吃得下的形狀——gemini 去 `additionalProperties`、強制 enum 型別；openai 攤平 `anyOf`、強制 `additionalProperties:false`。
- **自動 cache 斷點佈點**：`"auto"` 模式在最後一個工具定義、最後一段 system、最新使用者訊息落 ephemeral cache 標記。
- **models.dev 目錄 + 小模型自動挑**：跨程序檔案鎖的磁碟快取（5 分 TTL、每時刷新、內建 fallback）；以 `0.8*成本 + 0.2*新舊` 評分並比對名稱 `/(nano|flash|lite|mini|haiku|small|fast)/` 挑一個便宜模型給摘要/壓縮用。
- **retry 精修**：現況（查證 `upstream.mjs:33-41`、`net.mjs:34-38`）**已有**——尊重 Retry-After、全隨機 jitter 退避、overflow 一律不重試（交給 loop 的機械恢復）、串流 idle watchdog。本 change 只補缺的：**typed HTTP 狀態分類**（取代粗略的 429/5xx 判定）、**429 獨立低重試上限（2）**、grok 的 **`RetryWithImageStrip`**（某些含圖失敗改拆圖重試）、**空回應診斷**（記 had_reasoning/finish_reason/completion_tokens）。

## Capabilities

### New Capabilities
- `tool-schema-projection`：per-model schema 投影規則。
- `cache-breakpoint-policy`：auto 斷點佈點。
- `model-catalog`：models.dev 快取與小模型自動挑選評分。
- `retry-matrix`：typed 分類、Retry-After、image-strip、空回應診斷、context 溢出不重試。

## Impact

- **落點：unieai-agent-core**：`upstream.mjs`/provider 路由（schema 投影、cache 佈點、retry 補強）、新增 catalog/small-model 挑選。
- 兩層既有 retry 皆為疊加非取代：JS 側 agent-core `upstream.mjs`（RETRY_MAX=3、Retry-After、jitter、idle watchdog）與 Rust 側 UnieAI provider（75s idle + 3 retry + WS→HTTPS 降級）。
- 風險：schema 投影必須對「送出去給模型的工具」與「本地執行的工具」保持一致，投影只改 wire 表述不改語意。
