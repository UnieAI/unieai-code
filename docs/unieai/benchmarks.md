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

### SWE-bench Lite (flask 子集) — patch 生成

真實 GitHub issue，agent 在真實 flask repo 導航、定位、修改。3 個 instance × 3 引擎：

| 引擎 | 產出有效 patch | 定位正確檔案 |
|---|---|---|
| agent-core | 2/3 | ✅ blueprints.py, config.py |
| codex-stock | 1/3 | ✅ blueprints.py |
| codex-unieai | 1/3 | ✅ config.py |

agent-core 產出最多 patch 且兩次都定位到正確檔案。resolved 率（改的內容是否通過測試）需官方 docker harness 評分。

_資料集: [HumanEval](https://github.com/openai/human-eval) · [SWE-bench Lite](https://www.swebench.com)。模型: UnieAI gateway 上的 Qwen3.6-35B-A3B / GLM-5.2 / MiniMax-M2。_

---

## 重現方式

完整步驟見 [`benchmarks/AWS-TESTING.md`](../../benchmarks/AWS-TESTING.md)。腳本與資料集在 `benchmarks/`：

```bash
# HumanEval（三引擎 × 三模型）
UNIEAI_BIN=<binary> UNIEAI_HOME=~/.unieai node benchmarks/humaneval.mjs

# SWE-bench：生成 predictions → 官方 docker 評分
UNIEAI_BIN=<binary> node benchmarks/swebench-gen.mjs
python -m swebench.harness.run_evaluation \
  --predictions_path benchmarks/results/swebench-preds/agent-core.jsonl \
  --run_id test --dataset_name princeton-nlp/SWE-bench_Lite --max_workers 4
```

## 方法與誠實標註

- **資料集**：[HumanEval](https://github.com/openai/human-eval)（164 題官方 + 官方測試）、[SWE-bench Lite](https://www.swebench.com)（flask 子集）。
- **公平性**：同 gateway、同模型、每題全新 workspace、工具自動核准、pass@1（單次）。
- **HumanEval 已飽和**：現代模型普遍 88–99%（[業界共識](https://localaimaster.com/models/swe-bench-explained-ai-benchmarks)），三引擎打平只證明「整合不退化 + 效率」，**不能宣稱引擎讓模型更強**。
- **SWE-bench 樣本小**：目前僅 3 個 flask instance，是 proof-of-concept；resolved 率待更大樣本 + 官方 docker 評分。
- 引擎差異的真正戰場是 SWE-bench Verified / Pro 這類真實多檔任務。
