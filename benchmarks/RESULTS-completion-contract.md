# Completion contract on codex — raw material

SWE-bench Verified, 100-instance subset (`benchmarks/verified-100-subset.jsonl`).
Campaign run 2026-08-13. Everything below is measured; nothing is extrapolated.

This is source material, not a write-up. Numbers, quotes, file references, and the
things that went wrong.

---

## 1. Headline

| Model | Baseline (codex) | Contract, always-on | Contract, adaptive |
|---|---|---|---|
| Qwen3.6-35B-A3B | 16 | 38 | **45** |
| DeepSeek-V4-Flash-0731 | 83 | 80 | **84** |

Deltas vs baseline: Qwen **+29**, DeepSeek **+1**.

n = 100 → binomial SE ±3.6 points. +29 is 8 SE. +1 is 0.3 SE (flat, but not negative).

Observed run-to-run variance on identical configurations: **4 points**
(three Qwen baselines scored 20, 20, 16 across separate campaigns).

---

## 2. Full result table

| Model | Arm | Resolved | Empty-handed | Attempted | Per-patch accuracy |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | baseline | 16 | 71 | 29 | 55% |
| Qwen3.6-35B-A3B | always-on | 38 | 23 | 77 | 49% |
| Qwen3.6-35B-A3B | adaptive | **45** | 19 | 81 | **56%** |
| DeepSeek-V4-Flash-0731 | baseline | 83 | 1 | 99 | 84% |
| DeepSeek-V4-Flash-0731 | always-on | 80 | 0 | 100 | 80% |
| DeepSeek-V4-Flash-0731 | adaptive | **84** | 0 | 100 | **84%** |

DeepSeek adaptive's 84 is 77 from the first scoring pass plus 7 instances that had
errored on Docker Hub pull limits and resolved cleanly on re-scoring (see §10.4).

"Attempted" = instances that produced any diff. Per-patch accuracy = resolved ÷ attempted.

**The single most useful row-pair:** the always-on skeptic depressed per-patch accuracy
in *both* models (55→49, 84→80). The adaptive rule restored it in both (56, 84) while
keeping the attempt-rate gain. The skeptic's false positives were making patches worse
everywhere; only the frequency differed.

---

## 3. Instance-level overlap

Net score hides how much moved.

| Comparison | Both | Baseline only | Contract only | Net |
|---|---|---|---|---|
| Qwen, always-on vs baseline | 12 | 4 | 26 | +22 |
| Qwen, adaptive vs baseline | 13 | 3 | 32 | +29 |
| DeepSeek, always-on vs baseline | 73 | 10 | 7 | −3 |
| DeepSeek, adaptive vs baseline | 78 | 5 | 6 | +1 |

DeepSeek always-on did not quietly lose 3 — **17 outcomes flipped** (lost 10, gained 7).
That is the signature of noise, not of a consistent cost. Under the adaptive rule the
churn drops to 11 flips (5 lost, 6 gained).

---

## 4. Cost

100 instances, 4 workers, from retained trajectories (`timing.json`, `codex-stdout.jsonl`).

| Model | Arm | Sec/instance | Agent-hours | Total tokens | Tokens/instance |
|---|---|---|---|---|---|
| Qwen | baseline | 61 | 1.69 | 12.2M | 121,769 |
| Qwen | always-on | 182 | 5.06 | 36.1M | 360,975 |
| Qwen | adaptive | 143 | 3.96 | 34.8M | 348,167 |
| DeepSeek | baseline | 88 | 2.45 | 47.9M | 478,721 |
| DeepSeek | always-on | 128 | 3.55 | 78.0M | 779,847 |
| DeepSeek | adaptive | 102 | 2.83 | 58.9M | 589,296 |

Adaptive is better on every axis than always-on: more resolved, higher per-patch
accuracy, less time, fewer tokens.

Qwen adaptive still costs **2.3× baseline tokens for +29 points**. DeepSeek adaptive
costs **1.2× for +1** — inside the noise, so effectively "free but pointless".

---

## 5. What the contract is

Three gates at turn end, increasing cost. Runs as a codex `Stop` hook.

Two implementations, same behaviour: `codex-rs/completion-contract/` (shipping —
dispatched from argv as `unieai --run-as-completion-hook`, so the hook is the same
binary and version as the agent) and `completion-contract/` (the JS reference the
measurements below were taken with, kept as the executable spec).

| Gate | Fires when | Cost | Model call |
|---|---|---|---|
| mutation | nothing in the workspace changed | one `git status` | no |
| deterministic | changed Python fails to compile/import; test files edited | `py_compile` ×n | no |
| skeptic | a diff exists **and** the turn needed pushing | ~1k tokens | yes |

Hook contract: read `StopCommandInput` from stdin, answer
`{"decision":"block","reason":…}` to send the turn back, or `{}` to let it end.
Everything fails open.

Skeptic criteria (all derived from previously observed failure modes):
1. **LITERALS** — task quotes an exact output; verify the diff produces that literal
2. **SIBLINGS** — other code paths with the same flaw
3. **EXCEPTIONS** — expected exception types (`assert` where `ValueError` is wanted)
4. **REGRESSIONS** — circular imports, changed signatures under existing callers

---

## 6. Where the gain comes from

A run whose skeptic was silently broken became a clean ablation of it.

| Qwen3.6-35B-A3B configuration | Resolved | Empty-handed | Δ |
|---|---|---|---|
| codex baseline | 16 | 71% | — |
| + mutation & deterministic gates | 30 | 38% | +14 |
| + skeptic (always-on) | 38 | 23% | +8 |
| + skeptic (adaptive) | 45 | 19% | +7 more |

The cheap gates carry half. The skeptic adds on top — but only when it is not
allowed to speak on turns that did not need it.

---

## 7. The adaptive rule

**Run the skeptic only on a turn that had to be nudged to get here, or one the
deterministic gates flagged.**

`SkepticMode::Nudged` is the default; also accepts `always` and `never`.
Env override: `UNIEAI_SKEPTIC_MODE`.

Effect on how often the skeptic runs:

| Model | Always-on | Adaptive |
|---|---|---|
| DeepSeek | 97 / 100 sessions | 34 / 99 |
| Qwen | 125 / 178 sessions* | 44 / 100 |

\* Qwen's always-on figure spans two runs sharing one state directory; treat as approximate.

**Why this signal and not model size:** the predictor is the empty-handed rate
without any harness.

| Model | Empty-handed, no harness |
|---|---|
| Qwen3.6-35B-A3B | 71% |
| GLM-5.2 | 4% |
| DeepSeek-V4-Flash-0731 | 1% |

A model that produced a coherent diff unprompted and passed the syntax/import gates
has already demonstrated the behaviour the review is looking for. Measurable in ten
instances; no model whitelist to maintain.

Deployment guidance that falls out:

| Empty-handed rate | Configuration |
|---|---|
| > 40% | all gates on |
| 10–40% | gates on, skeptic adaptive |
| < 10% | cheap gates only (skeptic will almost never fire anyway) |

---

## 8. Comparison with the full in-house harness

Within-campaign deltas only (baseline re-measured in the same campaign).

| Model | Full harness (agent-core) | Contract only, adaptive |
|---|---|---|
| Qwen3.6-35B-A3B | 20 → 50 (**+30**) | 16 → 45 (**+29**) |
| DeepSeek-V4-Flash-0731 | 64 → 48 (**−16**) | 83 → 84 (**+1**) |
| GLM-5.2 | 85 → 81 (**−4**) | not measured |

One mechanism reproduces essentially all of the weak-model gain and none of the
strong-model harm.

⚠️ **Caveat on the DeepSeek full-harness row:** that campaign's baseline was 64 with
21% empty-handed, against 83 with 1% when re-measured cleanly. Direction is solid;
magnitude is not.

---

## 9. Quotes worth using

### The skeptic catching a real error
> The agent's report indicates that the proposed fix in the diff is incorrect
> (`ast.None` does not exist) and that the agent intends to fix it, but the diff
> provided **is** the incorrect code. […] it should be `ast.Constant(None)` in modern
> Python or `ast.NameConstant(None)`.

This is only possible because the hook input carries `last_assistant_message` — it
compared what the model *claimed* against what the diff *is*.

### The skeptic being wrong, and the model correctly rebutting it
> the verification check is flagging multiple `use_required_attribute` methods, but
> they belong to **different widget classes** with different purposes. None of them
> need the same fix.

> verification is flagging surface-level string matches that are **not** the same code
> pattern.

That is the SIBLINGS criterion doing textual matching and calling it a code smell.
Clearest defect the campaign exposed, and the most likely source of the always-on
accuracy drop.

### Instrumented false-positive rate
DeepSeek always-on: skeptic ran 97 times, ended with unresolved objections in **76**,
against a model whose patches were correct **84%** of the time.

---

## 10. Things that went wrong — five silent failures

None of these produced an error, a red test, or a log line. All were found by reading
data that looked wrong.

### 10.1 A verifier that silently agreed with everything
**Cost: one full run (~7 agent-hours)**

The skeptic read `choices[0].message.content`. Qwen answers with `content: null` and
puts the verdict in `reasoning_content` when it spends its whole budget thinking.
Empty verdict → read as "no gaps" → the gate approved everything. 58 sessions reached
the skeptic; zero objections; nothing reported a failure.

Fix: `chat_template_kwargs: {enable_thinking: false}` for the verdict call, plus a
fallback to `reasoning_content`.

### 10.2 Borrowing the host's re-entry guard as a budget
**Cost: 5× under-nudging**

codex sets `stop_hook_active` after accepting a block. We read it as "you have had
your turn". But codex does **not** cap repeated blocks — `session/turn.rs:402` sets the
flag and loops. The flag is informational. Our in-process version allowed five nudges;
the hook allowed one.

Caught in a smoke test on `astropy__astropy-12907`: with one nudge the model said
"I need to apply the fix" and stopped; with five it applied the correct fix
(`cright[...] = right`).

### 10.3 A backend outage landing entirely on one arm
**Cost: one 200-instance run discarded**

Running arm A to completion then arm B is only fair if conditions are stationary.
A ~12-minute 502 window hit **84 of 96** instances in the second arm and **40 of 100**
in the first. Raw numbers said the contract *tripled* the empty-handed rate (91% vs 39%).

Failure timeline (5-minute buckets, completed/failed):
```
 0–20 min   61 instances,   1 failed
25–35 min  128 instances, 123 failed   ← outage
40–45 min   11 instances,   0 failed
```
Instance counts inflate during the outage because a 502 returns in seconds.

Fix: alternate arms in short passes; re-run only instances whose turn actually failed.

### 10.4 Docker Hub pull rate limit read as a benchmark result
**Cost: nearly inverted the adaptive conclusion**

`cache_level env` deletes each instance image after use, so every evaluation re-pulls
~100 images. Six evaluations in one day exhausted the unauthenticated quota.

Qwen adaptive first scored **4/100 with 77 errors**. Taken at face value that reads as
"the adaptive rule destroyed the mechanism". The actual error:
```
429 Client Error … toomanyrequests: You have reached your unauthenticated pull rate limit
```
After the quota window reset, the same predictions scored **45/100, 0 errors**.

DeepSeek adaptive's earlier 7 errors were the same problem in its milder form
(`Read timed out (read timeout=60)` while pulling). Re-scored: **7/7 resolved**, moving
that arm from 77 to 84.

### 10.5 WebSocket client frames without masking
**Cost: an hour, during the cross-session investigation**

The app-server control socket speaks WebSocket. Reusing the JS bridge's `encodeFrame`
— written for the *server* side, which does not mask — produced a successful handshake
(HTTP 101) and then total silence. RFC 6455 §5.3 requires client→server masking; the
Rust side simply ignored the frames. No error, either side.

---

## 11. Reproduce

```bash
# Generation — one arm at a time, never two harness processes on one gateway
export UNIEAI_API_KEY=… UNIEAI_BASE_URL=…
export MODEL=Qwen3.6-35B-A3B
export INST_FILE=benchmarks/verified-100-subset.jsonl
export OUT_SUF=-hookab WORKERS=4
export UNIEAI_SKEPTIC_MODE=nudged        # or "always" / "never"
ARMS=codex-stock node benchmarks/swebench-gen-verified.mjs
ARMS=codex-hook  node benchmarks/swebench-gen-verified.mjs

# Evaluation
PRED_SUF=-hookab bash benchmarks/swebench-eval-verified.sh $MODEL
```

The `codex-hook` arm builds a CODEX_HOME containing `[[hooks.Stop]]` and passes
`--dangerously-bypass-hook-trust` (a hook declared in user config is Untrusted until a
hash is recorded, and an untrusted hook is silently skipped — which would make the arm
a copy of the baseline and report "the hook does nothing").

Both arms use the same stock prompt (`benchmarks/stock-codex-prompt.md`) so the only
difference is the hook.

---

## 12. Limits

- **Two models measured with the adaptive rule**, three with the always-on one. The
  empty-handed-rate predictor is a hypothesis fitted to three observations.
- **One turn per instance.** SWE-bench gives a single turn, so the escalation ladder and
  the stall exit are barely exercised. Nothing here says how the contract behaves in a
  long interactive session.
- **Python only.** The deterministic gate runs `py_compile` and an import check.
- **The skeptic's SIBLINGS criterion is known-defective** (textual matching). Fixing it
  would likely raise the always-on numbers; it has not been fixed or re-measured.
- **GLM-5.2 was never run through the contract**, only the full harness. Its baseline
  (85, 4% empty-handed) predicts an outcome close to DeepSeek's.
- **Error instances:** Qwen adaptive 0, DeepSeek adaptive 0 after re-scoring, Qwen
  always-on 1.

---

## 13. Open questions

1. Does fixing the SIBLINGS criterion (AST-level rather than textual) recover the
   always-on accuracy drop, making the adaptive rule unnecessary?
2. Does the adaptive rule hold on GLM-5.2 (4% empty-handed, 85 baseline)?
3. The Qwen full harness reaches 50 vs the contract's 45. The remaining ~5 points are
   tooling — read windows, test-runner detection, fuzzy edit matching. Which of those is
   worth porting to codex, and are any of them also negative on strong models?
4. Per-turn nudge budget is 5. Qwen's distribution shows 46 sessions hitting the cap —
   is a higher cap worth more, or is that the population that was never going to close?
