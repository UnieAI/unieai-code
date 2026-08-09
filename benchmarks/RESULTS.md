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

（上表 agent-core = uc0.1.0 baseline。SWE-bench 優化後的 uc0.4.0 回測見下。）

**uc0.4.0 回測（Qwen × agent-core，164 題）——確認 SWE-bench 優化沒拖累簡單任務：**

| 版本 | pass@1 | 平均時間 | 平均 token | vs codex-unieai |
|---|---|---|---|---|
| agent-core uc0.1.0 | 99% | 5.3s | 6,133 | 26% |
| **agent-core uc0.4.0** | **99%** (163/164) | 7.0s | 11,083 | **48%（仍省 52%）** |

uc0.4.0 正確率零退化;token 內部變 1.8×(空回應重採 + 加長 prompt 的稅),但
**仍只有 codex-unieai 的 48%、codex-stock 的 31%**——「比 codex 少即可接受」成立,
簡單任務省 token 屬可選內部優化,不為它冒損準確率的風險。

### 結論

1. **正確率三引擎全部打平（98–100%）**。HumanEval 對現代模型已飽和（[業界共識](https://localaimaster.com/models/swe-bench-explained-ai-benchmarks)，頂級模型皆 88–99%）——這證明三個引擎都**沒有拖累模型的原生能力**，整合乾淨。
2. **agent-core 一致省 5–8× token**（uc0.1.0 6.1k vs 36k = 5.9×；優化後 uc0.4.0 仍省 2× vs codex-unieai）。正確率飽和時，token/成本才是有意義的差異。
3. **agent-core 一致最快**（Qwen 快 1.5×、GLM 快 2×），且對三個模型都成立，含內嵌 `<think>` 的 MiniMax（think-filter 剝離後 98%，無退化）。

> HumanEval 測「單函式生成」，飽和後只能證明「不退化 + 效率」。真正區分 agent harness 能力的是 **SWE-bench**（真實 repo 多檔 bug 修復）——見下。

### SWE-bench Lite — 官方 docker harness 評分（resolved）

真實 GitHub issue，agent 在真實 repo 導航、定位、修改；`git diff` 交官方 harness 在 docker 內套用並跑官方測試。

**全量 300 題（Qwen3.6-35B-A3B，pass@1，最終定稿 2026-07-18）：**

| 引擎 | resolved | per-patch 修對率 | 空手率 | tokens/題 |
|---|---|---|---|---|
| **uc0.4.0-ac0.2.0** | **138/300 = 46.0%** | **53%** | 13% | ~380k |
| uc0.3.0-ac0.2.0 | 131/300 = 43.7% | 51% | 14% | ~380k |
| uc0.2.0-ac0.2.0 | 127/300 = 42.3% | 51% | 17% | 368k |
| uc0.1.0-ac0.1.0 | 83/300 = 27.7% | 53% | 47% | 123k |
| codex-unieai | 72/300 = 24.0% | 51% | 53% | — |
| codex-stock | 42/300 = 14.0% | 51% | 73% | — |

**成本／時間（同 300 題，pass@1，tokens 來自 traj usage、秒數來自 gen log）：**

| 模型 × harness | resolved | 總 tokens | 平均/題 | 平均秒/題 | 每 resolved 成本 |
|---|---|---|---|---|---|
| Qwen × codex-stock | 14.0% | 39.4M | 134k | 67s | 0.94M |
| Qwen × codex-unieai | 24.0% | 57.5M | 207k | 134s | 0.80M |
| Qwen × uc0.1.0 | 27.7% | 36.8M | 123k | 50s | **0.44M（最省）** |
| Qwen × uc0.2.0 | 42.3% | 109.4M | 368k | 161s | 0.86M |
| Qwen × uc0.3.0 | 43.7% | 134.7M | 451k | 137s | 1.03M |
| Qwen × uc0.4.0 | **46.0%** | 143.3M | 478k | 170s | **1.04M（最貴）** |
| MiniMax × uc0.2.0 | 47.0% | 163.4M | 545k | 251s | 1.16M |

> 版本命名 `ucX.Y.Z-acA.B.C`：uc = unieai-code(coding 層自己的版本)，
> ac = 它依賴的 unieai-agent-core 版本。下方所有 SWE-bench 數據是在 **ac0.2.0**
> 上跑的(標籤即歷史事實)；uc0.3.0 之後的優化全在 coding 層(agent-runtime)。
> agent-core 之後另出了 **ac0.3.0**(domain-agnostic hooks，供 Studio 分離用，
> 對 coding 行為向後相容)——現行 submodule 已指向 ac0.3.0,行為與 ac0.2.0 等價。
> minor(第二位)=有感功能/大動，patch(第三位)=小修。uc 階梯:0.1.0 baseline
> → 0.2.0 迴圈機制+完成契約(大) → 0.3.0 決定論閘門+skeptic → 0.3.1 靜態 diff
> 檢查(小補，未單獨評分，併入 0.4.0) → 0.4.0 工具即時驗證(現行)。

**兩個指標指向不同贏家，不可混談：**
- **要「解最多題」→ uc0.4.0（46.0%）**。這是「準確率優先」方針下的目標，達標。
- **要「每塊錢解最多題」→ uc0.1.0（0.44M/resolved）**。uc0.4.0 的每 resolved 成本
  是 uc0.1.0 的 **2.4 倍**，且是全表最高——換取準確率的代價，就是成為每 resolved
  最貴的配置。在「準確率優先、成本其次」的排序下可接受，但**不能稱它省或不浪費**。
- 回收槓桿：gateway 目前 `cached_input_tokens=0`，開 prompt caching 可壓 input（agentic
  負載 history 前綴天然可快取），是唯一不犧牲準確率的成本下降手段。

**跨模型(同 300 題,agent-core coding 層):**

| 模型 × 版本 | resolved | 備註 |
|---|---|---|
| Qwen × uc0.1.0 → uc0.4.0 | 27.7% → **46.0%** | +18.3pt,精修對弱模型幫助大 |
| MiniMax × uc0.2.0 | 47.0% | patch 率 97%、空手僅 8 題 |
| MiniMax × uc0.4.0 | 46.0%（289 完成，1 題 docker 限流）| 與 uc0.2.0 打平 |

兩個發現:
1. **harness 拉小模型、大模型拉更高** —— 同 harness 下 MiniMax(47%)> Qwen(46%)。
2. **精修的邊際遞減,且模型越強越小** —— uc0.3.0→uc0.4.0 的決定論閘門/skeptic/工具
   即時驗證把 Qwen 從 43.7%→46.0%,但對 MiniMax 幾乎中性(47→46,雜訊內)。這些機制
   補的是空 patch、字面錯、漏 sibling 等短板,**強模型本來就少犯,可補空間小**。harness
   優化的本質是補模型短板,模型越強、能補的越少。

各版增量(Qwen):uc0.3.0 +決定論閘門+skeptic v2(+1.4pt);**uc0.4.0 把同樣的檢查
搬進 edit/write 工具、動作當下即時回饋(+2.3pt、per-patch 首升 51→53%)——「智慧放
進工具而非提示詞、回饋在動作當下」原則的數據驗證。**

**uc0.2.0 = uc0.1.0 + 一日優化(含 agent-core 0.1.0→0.2.0)**（grok-build / codex-rs 逐行研究移植）：progress-aware
doom streak、completionCheck 完成契約（mutation gate + skeptic 驗證 + 缺口重播）、
空回應重採樣、內容感知 stall 計時器、孤兒 tool-call 修復、edit 四層模糊匹配、
act-don't-announce prompt 紀律、maxSteps 24→96。詳見 `docs/grok-build-research.md`
與 agent-core CHANGELOG。

> 註:早期曾用 flask 3-instance 子集快速調參,但 n=3 統計上是雜訊,且結論與
> 全量 300 題相反(該子集恰為難題,agent-core 在上面 0/3,反而 codex-unieai
> 配 GLM 偶然 3/3)——已棄用,一切以全量數字為準。這是本專案的方法論教訓:
> 小樣本會誤導方向。

重點：
1. **四個 arm 的 per-patch 修對率幾乎相同（51–53%）——引擎差異全在空手率**。
   新碼把空手率 47%→17%，resolved 率 +14.6pt（相對 +53%），全 300 題穩定領先。
2. 成本（見上表）：優化提升絕對解題數，但**每 resolved 成本一路上升**
   （uc0.1.0 0.44M → uc0.4.0 1.04M，2.4×）。uc0.4.0 解最多題、也最貴/resolved；
   uc0.1.0 最省/resolved。「準確率優先」下選 uc0.4.0，但別把它當成省——它不是。
   gateway prompt caching 是唯一不犧牲準確率的成本回收。
3. 位置：35B-A3B 開源小模型 + 新 harness = **46.0%(uc0.4.0)**；同期公開榜首 Claude Opus
   4.6 = 62.7%、MiniMax M2.5 = 56.3%；2024 年 GPT-4 + SWE-agent ≈ 18%。
4. 跨模型:MiniMax-M2 × uc0.2.0 = 47.0%(同 harness、更強模型 → 更高),
   佐證「harness 拉小模型、大模型拉更高」。

（評分於 AWS 以官方 `swebench==4.1.0` harness、`princeton-nlp/SWE-bench_Lite` dataset 完成，2026-07-18。）

### SWE-bench Verified — GLM-5.2(2026-08-09)

Verified 是 OpenAI 找專業開發者逐題人工驗證的 500 題子集(確認 issue 敘述足以推導
修法、FAIL_TO_PASS 測試正確且不 flaky),是目前業界報數字的標準。以下用其中 **100 題
分層抽樣子集**(repo 分布與全量一致:django 46%、sympy 15%、sphinx 9%…),
pass@1、bare clone、獨佔 gateway。

| harness | resolved | 空手 | per-patch 修對率 | tokens/題 | 秒/題 |
|---|---|---|---|---|---|
| codex-stock | **85** | 4 | 89% | 1224k | 451s |
| **agent-core(本輪最終)** | **83** | 2 | 85% | 1259k | 382s |
| agent-core(起點 uc0.4.0) | 67 | 15 | 79% | 790k | 359s |

83 vs 85 在 n=100 的二項標準誤(±3.6)內 → **統計上持平,未超越 codex**。
實測 run-to-run 變異約 ±5 題,所以單輪差 2 分不具意義。

**67 → 83 的來源(每一項都從失敗軌跡反推,非猜測):**

| 修正 | 症狀 |
|---|---|
| `read` 加 offset/limit | 沒有行視窗時,模型要第 4000 行卻永遠拿到同一段檔頭,判定工具壞掉後改用 `sed -n` 走 bash —— 帶視窗的 read 從 0% 升到 95% |
| context 預算 32k → 128k | agent-core 的預設是它初期對應的模型尺寸;coding 層從未覆寫。60 步的回合每題剪 15 次工具輸出、只留最近 2 輪,模型 **68% 的檔案讀取是在重讀**,而剪枝只省該回合 **0.5%** token |
| turn deadline 接線 | `deadlineHit()` 與 `deadlineAt` 早已寫好卻從沒被設定,gateway 不穩時一路重試到被外部 SIGKILL(單題 240 秒燒在 3 次 retry),交出空 patch |
| doom 收尾不繞過完成契約 | 強制收尾會跳過「你還沒改任何東西」的檢查 |
| mutation gate 的 untracked 破口 | `git status` 算 untracked、`git diff` 不算 → 只寫了 repro 腳本的回合既過關又跳過驗證 |
| 串流中斷自動重試 | 一次 gateway 中斷報銷整個回合:14 題 → 0 題 |
| 紅色測試不再算工具失敗 / 編輯後清空重複守衛 | 跑測試看到紅字被當成打轉(doom 權重加倍),改完想重跑同一測試被拒絕(最重懲罰)—— **模型愈認真驗證愈快被切斷** |

**失敗的方向(記錄下來避免重做):**

- **容器模式**:把生成階段搬進官方 `sweb.eval` image 讓 agent 真能跑測試 —— 直覺該提升
  per-patch 修對率,實測**下降**(85%→76%,74 vs 83)且貴 23%。已保留但預設關閉。
- **`edit-signals`**:依 5 個失敗個案反推的兩個編輯檢查,100 題**零觸發**。純過度擬合。
- **多次採樣的選擇器**:多數決無鑑別力(有共識 86% vs 無共識 85%);LLM 評審 63% 命中,
  換算總分與單次持平。註:該次驗證的候選池混入了有工具缺陷的 run,結論不可信,待重測。

**方法論教訓:**

1. **絕不讓兩組 arm 同時打同一個 gateway。** 平行跑讓每次模型呼叫從 6.5s 拖到 8.6s,
   四分之一題目撞上 900s 上限,分數被吃掉 6 分,並一度讓我誤判成「框架往返成本比
   codex 高 43%」(獨佔後是 6.5 vs 6.0,差距接近 0)。
2. **機制要從失敗的分布導出,不要從個案反推**(見 edit-signals)。
3. **子集會騙人。** 30 題子集顯示 context 修正 +6 分,全量 100 題是持平 —— 與 Lite 時代
   flask 3 題的教訓同一類。

**剩下 17 題的失敗結構:** 11 題定位 100% 正確、patch 大小與官方相當、PASS_TO_PASS 全綠,
差在具體實作與隱藏測試的期待不一致(往往只差一個函式呼叫或一組括號)。codex 的失敗結構
相同(85% 屬同一類),這也是兩邊分數接近的原因。工具與流程的優化在此已接近飽和。

（評分於官方 `swebench==4.1.0` harness、`princeton-nlp/SWE-bench_Verified` dataset 完成。）

_資料集: [HumanEval](https://github.com/openai/human-eval) · [SWE-bench Lite](https://www.swebench.com)。模型: UnieAI gateway 上的 Qwen3.6-35B-A3B / GLM-5.2 / MiniMax-M2。_
