# Changelog — @unieai/code-agent-runtime (coding layer)

UnieAI Code's coding layer on top of the `unieai-agent-core` loop. Versions are
`ucX.Y.Z` and always pair with a specific agent-core version `acA.B.C` — see the
`third_party/unieai-agent-core` submodule. Coding-specific mechanisms live here;
generic loop/transport mechanisms live in agent-core.

Benchmark headline (SWE-bench Lite 300, pass@1, Qwen3.6-35B-A3B; full data in
`benchmarks/RESULTS.md`): **0.1.0 → 0.4.0: resolved 27.7% → 46.0%** with no
HumanEval regression (99%, 11.1k tok/task — still 52% under codex-unieai).

Versioning: minor (Y) = a feature / substantial change, patch (Z) = small fix.

## 0.4.0 (with ac0.2.0) — 2026-07-19

Smart tools: instant verification moved into the edit/write tools themselves —
the same tool result carries the feedback, at the moment of action, instead of a
completion-time gate N steps later (user directive: "intelligence in the tools,
not the prompt"). SWE-bench Lite 43.7% → **46.0%**, per-patch 51% → 53% (first
per-patch gain). Includes the 0.3.1 static checks.
- `tools.mjs`: after any `.py` write/edit, attach to the tool result — a
  `py_compile` verdict (syntax break flagged when it happens) and a
  surviving-identical-sibling note (the replaced line still exists verbatim
  elsewhere). Clean edits stay noise-free.

## 0.3.1 (with ac0.2.0) — 2026-07-19

Static diff checks — deterministic, dependency-free text analysis added to the
completion contract (small; not benchmarked standalone; folded into 0.4.0):
- test-file edit detection (SWE-bench contract violation)
- exception-type contract: task names `FooError` but diff adds a bare `assert`
- surviving-identical-line sibling scan (exact match, zero false positives)

## 0.3.0 (with ac0.2.0) — 2026-07-18

Completion contract, deterministic gates + skeptic v2. SWE-bench Lite 42.3% →
**43.7%** (marginal; the wins here are catchable-by-execution failure modes):
- `deterministicGates`: `py_compile` syntax gate + import smoke gate on changed
  `.py` files; external missing-dependency errors never false-positive.
- skeptic v2 prompt: LITERALS / SIBLINGS / EXCEPTIONS / REGRESSIONS checklist,
  driven by the SWE-bench failure-mode analysis.
- guidance: run the changed entry point and compare quoted literals before done.
- `completionCheckMax` raised so the mutation gate, deterministic gates, and one
  skeptic gap-replay round each get a turn.

## 0.2.0 (with ac0.2.0) — 2026-07-18

First optimization round. Pairs with agent-core's 0.1.0 → 0.2.0 loop bump.
SWE-bench Lite **27.7% → 42.3%** (+14.6pt) — almost entirely by cutting the
empty-patch rate 47% → 17%.
- `workspaceCompletionCheck`: action turns get a completion contract via
  agent-core's `ctx.completionCheck` seam — mutation gate (claims done but the
  workspace is untouched → nudge) + LLM skeptic verify with gap replay.
- edit tool: 4-tier fuzzy matching (exact / rstrip / trim / unicode-normalize) +
  trailing-newline retry; bash output middle-truncation (keep head AND tail).
- prompt: act-don't-announce, verify-after-state-change, adapt-on-failure,
  assert-vs-raise discipline; `maxSteps` 24 → 96 (backstop cap, not a target —
  both codex-rs and grok-build run uncapped and rely on quality gates);
  doom-streak thresholds 10/14.

Cross-model (same harness): MiniMax-M2 × uc0.2.0 = 47.0% — "harness lifts a
small model; a stronger model lifts further."

## 0.1.0 (with ac0.1.0) — baseline

UnieAI Code on the agent-core loop: coding tools (bash/read/write/edit), session
persistence, slim TUI. SWE-bench Lite 27.7%, HumanEval 99% @ 6.1k tok/task.
Most cost-efficient per resolved (0.44M tok), but highest empty-patch rate.
