## Benchmark: UnieAI Code 引擎對照

三個引擎在**公開資料集 HumanEval**（OpenAI 官方 164 題 + 官方測試）上，橫跨三個開源模型的表現。同一 gateway、每題全新 workspace、pass@1（單次嘗試，官方 test 判定）。

- **codex-stock** — 未修改的 OpenAI codex 流程（原版 GPT 調校提示）
- **codex-unieai** — codex + UnieAI 精簡提示（我們的 fork）
- **agent-core** — [unieai-agent-core](https://github.com/unieai/unieai-agent-core) 迴圈（與 UnieAI Studio 共用）

### HumanEval pass@1 × 三模型

| 模型 | 引擎 | pass@1 | 平均時間 | 平均 token |
|---|---|---|---|---|
| **Qwen3.6-35B-A3B** (164題) | codex-stock | 98% (161/164) | 7.8s | 36,066 |
| | codex-unieai | 99% (162/164) | 8.1s | 23,150 |
| | **agent-core** | **99% (163/164)** | **5.3s** | **6,133** |
| **GLM-5.2** (40題) | codex-stock | 98% (39/40) | 34.8s | 25,020 |
| | codex-unieai | 98% (39/40) | 37.6s | 18,984 |
| | **agent-core** | 98% (39/40) | **17.7s** | **3,374** |
| **MiniMax-M2** (40題) | codex-stock | 100% (40/40) | 10.5s | 27,409 |
| | codex-unieai | 100% (40/40) | 14.4s | 20,780 |
| | **agent-core** | 98% (39/40) | 10.2s | **5,463** |

### 結論

1. **正確率三引擎全部打平（98–100%）**。HumanEval 對現代模型已飽和（[業界共識](https://localaimaster.com/models/swe-bench-explained-ai-benchmarks)，頂級模型皆 88–99%）——這證明三個引擎都**沒有拖累模型的原生能力**，整合乾淨。
2. **agent-core 一致省 5–8× token**（Qwen: 6.1k vs 36k = 5.9×；GLM: 3.4k vs 25k = 7.4×）。正確率飽和時，token/成本才是有意義的差異——長對話差距持續放大。
3. **agent-core 一致最快**（Qwen 快 1.5×、GLM 快 2×），且對三個模型都成立，含內嵌 `<think>` 的 MiniMax（think-filter 剝離後 98%，無退化）。

> HumanEval 測「單函式生成」，飽和後只能證明「不退化 + 效率」。真正區分 agent harness 能力的是 **SWE-bench**（真實 repo 多檔 bug 修復）——見下。

### SWE-bench Lite — 官方 docker harness 評分（resolved）

真實 GitHub issue，agent 在真實 repo 導航、定位、修改；`git diff` 交官方 harness 在 docker 內套用並跑官方測試。

**全量 300 題（Qwen3.6-35B-A3B，pass@1，最終定稿 2026-07-18）：**

| 引擎 | resolved | per-patch 修對率 | 空手率 | tokens/題 |
|---|---|---|---|---|
| **agent-core v0.2.0** | **127/300 = 42.3%** | 51% | 17% | 368k |
| agent-core v0.1.0 | 83/300 = 27.7% | 53% | 47% | 123k |
| codex-unieai | 72/300 = 24.0% | 51% | 53% | — |
| codex-stock | 42/300 = 14.0% | 51% | 73% | — |

**v0.2.0 = v0.1.0 + 一日優化**(版本對應 agent-core CHANGELOG)（grok-build / codex-rs 逐行研究移植）：progress-aware
doom streak、completionCheck 完成契約（mutation gate + skeptic 驗證 + 缺口重播）、
空回應重採樣、內容感知 stall 計時器、孤兒 tool-call 修復、edit 四層模糊匹配、
act-don't-announce prompt 紀律、maxSteps 24→96。詳見 `docs/grok-build-research.md`
與 agent-core CHANGELOG。

**flask 3-instance 子集 × 三模型（resolved / 3）：**

| 引擎 | Qwen3.6-35B-A3B | GLM-5.2 | MiniMax-M2 |
|---|---|---|---|
| codex-stock | 0 | 1 | 0 |
| codex-unieai | 0 | **3** ✅ | 0 |
| agent-core | 0 | 0 | 0 |

重點：
1. **四個 arm 的 per-patch 修對率幾乎相同（51–53%）——引擎差異全在空手率**。
   新碼把空手率 47%→17%，resolved 率 +14.6pt（相對 +53%），全 300 題穩定領先。
2. 成本：新碼 3× tokens/題（步數 14→28、每步重送 history、gateway 無 prompt
   cache），每 resolved 成本 0.4M→0.9M tok。準確率優先方針下可接受；gateway 開
   prompt caching 是最大的免費回收。
3. 位置：35B-A3B 開源小模型 + 新 harness = **42.3%**；同期公開榜首 Claude Opus
   4.6 = 62.7%、MiniMax M2.5 = 56.3%；2024 年 GPT-4 + SWE-agent ≈ 18%。
4. **GLM-5.2 + codex-unieai 在 flask 子集 3/3 全解**，同模型 codex-stock 只有 1/3。
5. flask 3 題恰為難題、隨機性大，早期以它調參曾誤導方向——以全量數字為準。

（評分於 AWS 以官方 `swebench==4.1.0` harness、`princeton-nlp/SWE-bench_Lite` dataset 完成，2026-07-18。）

_資料集: [HumanEval](https://github.com/openai/human-eval) · [SWE-bench Lite](https://www.swebench.com)。模型: UnieAI gateway 上的 Qwen3.6-35B-A3B / GLM-5.2 / MiniMax-M2。_
