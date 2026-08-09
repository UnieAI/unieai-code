// The loop prunes tool outputs once history passes its context budget, keeping
// only the last couple of rounds. agent-core's default is 32k — the size of the
// models it was written against — and the coding layer never overrode it, so a
// 60-step SWE-bench turn pruned ~15 times per instance and the model re-read the
// same files 68% of the time. The budget is now declared here and adjustable at
// runtime (`/context`), because the right value depends on the model in use.
import { test } from "node:test";
import assert from "node:assert/strict";

const { createEngine } = await import("./engine.mjs");

// createEngine touches credentials/session state, so exercise the pure setter
// contract through a minimal instance in a throwaway workspace.
function engineWith(opts = {}) {
  return createEngine({ workspace: process.cwd(), model: "m", ...opts });
}

test("the coding layer declares a modern default, not agent-core's 32k", () => {
  assert.equal(engineWith().contextTokens, 128_000);
});

test("an explicit budget is honoured", () => {
  assert.equal(engineWith({ contextTokens: 200_000 }).contextTokens, 200_000);
});

test("the budget can be changed at runtime", () => {
  const e = engineWith();
  assert.equal(e.setContextTokens(64_000), 64_000);
  assert.equal(e.contextTokens, 64_000);
});

test("a budget too small to hold one file is floored", () => {
  // Below this the pruning thrashes: every read is discarded before it is used.
  const e = engineWith();
  assert.equal(e.setContextTokens(1_000), 8_000);
  assert.equal(e.setContextTokens(0), 128_000); // 0/NaN means "unset" → default
  assert.equal(e.setContextTokens("nonsense"), 128_000);
});

test("the setter reports what was actually applied", () => {
  const e = engineWith();
  const applied = e.setContextTokens(500);
  assert.equal(applied, e.contextTokens);
});
