import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNudge, isStrategistPhase, STRATEGIST_THRESHOLD } from "./completion-escalation.mjs";

test("below threshold: plain gap nudge", () => {
  const n = buildNudge({ consecutiveNotAchieved: 1, gapText: "- fix the parser\n- handle empty input" });
  assert.match(n, /skeptical review/);
  assert.match(n, /fix the parser/);
  assert.doesNotMatch(n, /reconsider your WHOLE approach/);
});

test("at threshold: strategist nudge tells the model to change strategy", () => {
  const n = buildNudge({ consecutiveNotAchieved: STRATEGIST_THRESHOLD, gapText: "- still failing" });
  assert.match(n, /failed review 3 times/);
  assert.match(n, /reconsider your WHOLE approach|changed strategy/);
  assert.match(n, /still failing/, "the gaps are still included");
});

test("above threshold keeps escalating and reports the count", () => {
  const n = buildNudge({ consecutiveNotAchieved: 5, gapText: "- x" });
  assert.match(n, /failed review 5 times/);
});

test("isStrategistPhase flips exactly at the threshold", () => {
  assert.equal(isStrategistPhase(STRATEGIST_THRESHOLD - 1), false);
  assert.equal(isStrategistPhase(STRATEGIST_THRESHOLD), true);
  assert.equal(isStrategistPhase(STRATEGIST_THRESHOLD + 2), true);
});

test("custom threshold is honored", () => {
  assert.match(buildNudge({ consecutiveNotAchieved: 2, gapText: "-g", threshold: 2 }), /reconsider your WHOLE approach/);
  assert.doesNotMatch(buildNudge({ consecutiveNotAchieved: 2, gapText: "-g", threshold: 4 }), /reconsider your WHOLE approach/);
});
