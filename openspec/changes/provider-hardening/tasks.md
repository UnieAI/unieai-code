# Tasks: provider-hardening

## 1. 研究對照
- [ ] 1.1 讀 opencode `tool-schema.ts`（gemini/openai 投影）、`cache-policy.ts`、`catalog.ts:234-294`（小模型評分）、`models-dev.ts:154-251`、`route/executor.ts:345-364`（retry）
- [ ] 1.2 讀 grok `retry.rs:8-43,122,164-170,351`（429 cap、image-strip、空回應日誌）
- [ ] 1.3 盤點現行 agent-core upstream/provider（UnieAI provider idle/retry/降級）

## 2. schema 投影 — N/A（查證後不做）
- [~] 2.1 per-model compatibility 投影 — **不適用**：agent-core 只送 UnieAI gateway（OpenAI 相容 chat/responses，見 upstream.mjs:205 + responses-wire.mjs），無 anthropic/gemini 直連路徑，故無 gemini 去 additionalProperties / openai 攤平 anyOf 的場景

## 3. cache 斷點 — N/A（查證後不做）
- [~] 3.1 auto ephemeral cache 佈點 — **不適用**：cache_control 是 Anthropic 專屬，gateway 上的開源模型不支援

## 4. 目錄與小模型挑選
- [~] 4.1 models.dev 磁碟快取 — **不做**：UnieAI gateway 目錄僅 {id,name}，無 cost/context，models.dev（外部 OpenAI/Anthropic 目錄）對 gateway 部署無對應
- [x] 4.2 小模型評分挑選，接到摘要/壓縮呼叫 — `agent-core/src/model-picker.mjs` `pickSmallModel()`：從名稱推參數量（MoE 取 active）+ word-bounded small-hint，排除 speech/embedding；engine 的 summary 呼叫已改用 `auxModel`。9 tests。（因目錄無 cost，改用參數量代理，非 opencode 的 0.8*cost 評分）

## 5. retry 精修
- [x] 5.1 現況已有 Retry-After + backoff + status 分類；本 change 加 **429 獨立低上限**（`RETRY_MAX_429`=2，`AGENT_1_0_RETRY_MAX_429` 可覆寫；`classifyStepError` 回 `rateLimited`，retry 迴圈用專屬 counter）
- [x] 5.2 context 溢出不重試 — 現況已有（`classifyStepError` overflow 分類 + loop 機械恢復），未動
- [x] 5.3 空回應診斷日誌 — `empty_response_retry` 加 `hadReasoning/finishReason/completionTokens`。RetryWithImageStrip **不做**（agent-core coding 請求不帶圖，無適用場景；標 deferred）

## 6. 驗收
- [ ] 6.1 單元：schema 投影對 gemini/openai 形狀正確、語意不變
- [ ] 6.2 單元：小模型挑選評分
- [ ] 6.3 整合：429/Retry-After、image-strip 路徑
- [ ] 6.4 openspec validate + archive
