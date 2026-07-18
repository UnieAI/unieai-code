# AWS 測試指南 — UnieAI Code 引擎 benchmark

在乾淨的 AWS 機器上照著跑，重現 HumanEval + SWE-bench 三引擎對照。
（本機因 Docker Desktop 卡住無法跑 SWE-bench docker 評分；AWS 上 Docker 正常即可完成。）

---

## 0. 前置需求

- **Node ≥ 20**、**Python 3.10+**、**git**、**Docker**（SWE-bench 評分才需要）
- 一台能連到 UnieAI gateway 的機器

---

## 1. Clone（務必帶 submodule）

```bash
git clone --recursive -b unieai-codex https://github.com/UnieAI/unieai-code.git
cd unieai-code
# 若忘了 --recursive：
git submodule update --init --recursive
```

`third_party/unieai-agent-core` 會拉到 **main**（已含 PR #1 + #2：流程、Responses API、核准縫、idle-timeout、`<think>` 剝離器）。

---

## 2. Build CLI binary（Rust）

```bash
cd codex-rs
CARGO_PROFILE_DEV_DEBUG=0 cargo build --release --bin codex
# 產物：codex-rs/target/release/codex
export UNIEAI_BIN="$PWD/target/release/codex"
cd ..
```
> 用 `--release` 跑 benchmark（快很多）。debug build 也可，但慢。

---

## 3. 登入（寫入 ~/.unieai/unieai.json，engine 與 CLI 共用）

```bash
"$UNIEAI_BIN" login --studio-url https://studio.demo.unieai.com
# 依畫面在瀏覽器確認代碼。完成後模型清單會存進 ~/.unieai/unieai.json
export UNIEAI_HOME="$HOME/.unieai"
```

若在無瀏覽器的機器：可把本機登入好的 `~/.unieai/unieai.json` scp 過去。

---

## 4. agent-runtime 依賴

```bash
cd agent-runtime && npm install --silent && cd ..
# （只有 marked / eslint 等 devDeps；核心無 runtime 依賴）
```

---

## 5. 跑 HumanEval（三引擎 × 三模型）

```bash
UNIEAI_BIN="$UNIEAI_BIN" UNIEAI_HOME="$UNIEAI_HOME" \
  node benchmarks/humaneval.mjs
```

可調整範圍（env）：
```bash
# 只跑 Qwen 全部 164 題、只比 agent-core vs codex-unieai
MODELS="Qwen3.6-35B-A3B:164" ARMS="codex-unieai,agent-core" \
  node benchmarks/humaneval.mjs
```
結果 → `benchmarks/results/humaneval.json` + 逐題 stdout。

**引擎說明**：
| 引擎 | 意義 |
|---|---|
| `codex-stock` | 未改的 OpenAI codex 流程（原版 GPT 提示，`stock-codex-prompt.md`） |
| `codex-unieai` | codex + UnieAI 精簡提示（fork 預設） |
| `agent-core` | unieai-agent-core 迴圈（與 Studio 共用） |

---

## 6. 跑 SWE-bench Lite（真實 agentic）

### 6a. 生成 predictions（agent 讀真實 issue 改真實 repo）

```bash
UNIEAI_BIN="$UNIEAI_BIN" UNIEAI_HOME="$UNIEAI_HOME" \
  node benchmarks/swebench-gen.mjs
# → benchmarks/results/swebench-preds/{codex-stock,codex-unieai,agent-core}.jsonl
```
> 預設 flask 子集（3 instance，`flask-instances.jsonl`）。要換 repo/更多 instance，改 `REPO_URL` + `INST_FILE`。
> 本 repo 已附一組先前生成的 predictions 在 `benchmarks/swebench-preds/`，可直接拿去評分。

### 6b. 官方 docker 評分（AWS 上 Docker 正常）

```bash
python3 -m venv /tmp/sweb && /tmp/sweb/bin/pip install swebench
/tmp/sweb/bin/python -m swebench.harness.run_evaluation \
  --predictions_path benchmarks/results/swebench-preds/agent-core.jsonl \
  --run_id unieai-agentcore \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --max_workers 4
# 對 codex-stock.jsonl / codex-unieai.jsonl 各跑一次，比 resolved 率
```
評分報告會產在當前目錄的 `<run_id>.json`，含每個 instance 的 resolved 判定。

---

## 7. 已知本機結果（供對照，AWS 應能重現）

見 [`RESULTS.md`](RESULTS.md)。摘要：HumanEval 三引擎 98–100% 打平（飽和），**agent-core token 省 5–8×、速度快 1.5–2×**；SWE-bench Lite 官方 docker 評分（Qwen、~40 instance）：**agent-core 43% resolved、codex-unieai 40%、codex-stock 16%**；GLM-5.2 + codex-unieai 於 flask 子集 3/3 全解。

---

## 疑難排解

- **`no models available`**：`unieai login` 沒完成，或 Studio 帳號沒開通模型 → 到 `<studio>/models` 新增。
- **agent-core 找不到 sandbox**：確認 `UNIEAI_BIN` 指向已 build 的 binary（agent-core 的 bash 工具用 `unieai sandbox`）。
- **HumanEval codex 出現 0tok**：binary 路徑錯或崩潰 → 檢查 `$UNIEAI_BIN --version`。
- **gateway stall（單題數十秒）**：開源模型 gateway 偶發，agent-core 有 75s idle-timeout 自動重試；codex 路徑同樣有 stream_idle_timeout。
