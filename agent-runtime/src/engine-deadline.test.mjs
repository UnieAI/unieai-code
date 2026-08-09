// The loop and the upstream retry logic have both supported a turn deadline all
// along; the engine simply never passed one. The cost showed up on a degraded
// gateway: a turn would spend minutes retrying, get SIGKILLed by the caller's
// wall clock mid-edit, and hand back nothing — while `deadlineHit()` would have
// wrapped it up in time and `deadlineAt` would have stopped the doomed retries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { landingDeadline } from "./engine.mjs";

test("no deadline stays no deadline (interactive use is unchanged)", () => {
  assert.equal(landingDeadline(0), 0);
  assert.equal(landingDeadline(undefined), 0);
  assert.equal(landingDeadline(-1), 0);
});

test("a reserve is held back so the wrap-up call itself can complete", () => {
  // The caller aborts at 900s; the loop must start landing well before that.
  assert.equal(landingDeadline(900_000), 720_000);
  assert.equal(landingDeadline(1_800_000), 1_440_000);
});

test("the reserve never swallows more than half the budget", () => {
  // A 60s turn keeps 30s of working time rather than being reserved to nothing.
  assert.equal(landingDeadline(60_000), 30_000);
  assert.equal(landingDeadline(10_000), 5_000);
  for (const t of [1_000, 30_000, 120_000, 600_000, 3_600_000]) {
    assert.ok(landingDeadline(t) >= t / 2, `${t} reserved more than half`);
    assert.ok(landingDeadline(t) < t, `${t} reserved nothing`);
  }
});

test("the floor keeps a usable reserve for short budgets", () => {
  // 20% of 300s is 60s, which is not enough for a slow model call — the 90s floor
  // applies instead.
  assert.equal(landingDeadline(300_000), 210_000);
});

test("the deadline is always a whole number of milliseconds", () => {
  for (const t of [7_777, 123_457, 999_999]) {
    assert.equal(landingDeadline(t), Math.round(landingDeadline(t)));
  }
});
