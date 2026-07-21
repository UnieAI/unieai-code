import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlan,
  openSteps,
  reconcilePlan,
  planNudgeBlock,
  buildPlanRequest,
} from "./goal-plan.mjs";

test("parsePlan reads a JSON array of strings", () => {
  const p = parsePlan('["parse the input", "handle the empty case"]');
  assert.deepEqual(p.steps.map((s) => s.text), ["parse the input", "handle the empty case"]);
  assert.ok(p.steps.every((s) => s.done === false));
});

test("parsePlan tolerates ```json fences and a { steps } wrapper", () => {
  const fenced = parsePlan('```json\n["a step here", "another step"]\n```');
  assert.deepEqual(fenced.steps.map((s) => s.text), ["a step here", "another step"]);
  const wrapped = parsePlan('{"steps": ["wrapped step one", "wrapped step two"]}');
  assert.deepEqual(wrapped.steps.map((s) => s.text), ["wrapped step one", "wrapped step two"]);
});

test("parsePlan reads markdown checkboxes and preserves done state", () => {
  const p = parsePlan("- [x] scaffold module\n- [ ] wire the handler\n- [ ] add the guard");
  assert.equal(p.steps.length, 3);
  assert.equal(p.steps[0].done, true);
  assert.equal(p.steps[1].done, false);
  assert.deepEqual(openSteps(p), ["wire the handler", "add the guard"]);
});

test("parsePlan is fail-closed: malformed / empty → null", () => {
  assert.equal(parsePlan(""), null);
  assert.equal(parsePlan("   \n  "), null);
  assert.equal(parsePlan("not json and no bullets"), null); // plain prose, no markers
  assert.equal(parsePlan("[]"), null);
  assert.equal(parsePlan("- [ ]   \n- [ ]  "), null); // empty labels dropped → null
});

test("parsePlan caps step count and label length", () => {
  const many = parsePlan(JSON.stringify(Array.from({ length: 20 }, (_, i) => `step number ${i}`)), { maxSteps: 3 });
  assert.equal(many.steps.length, 3);
  const long = parsePlan(JSON.stringify(["x".repeat(500)]), { maxLen: 40 });
  assert.equal(long.steps[0].text.length, 40);
});

test("openSteps is safe on null / empty plan", () => {
  assert.deepEqual(openSteps(null), []);
  assert.deepEqual(openSteps({}), []);
  assert.deepEqual(openSteps({ steps: [] }), []);
});

test("reconcilePlan checks off a step whose tokens are covered by the diff", () => {
  const p = parsePlan('["validate the username argument", "render the footer banner"]');
  reconcilePlan(p, "def validate(username): render the argument checks");
  // "validate", "username", "argument" all present → first step done.
  assert.equal(p.steps[0].done, true);
  // "footer"/"banner" absent → second step still open.
  assert.equal(p.steps[1].done, false);
  assert.deepEqual(openSteps(p), ["render the footer banner"]);
});

test("reconcilePlan is conservative: partial coverage leaves the step open", () => {
  const p = parsePlan('["validate the username argument here"]');
  reconcilePlan(p, "validate only"); // only 1 of 3 significant tokens present
  assert.equal(p.steps[0].done, false);
});

test("reconcilePlan needs >=2 significant tokens to ever check off", () => {
  const p = parsePlan('["migrate everything"]'); // only "migrate" is significant (>=4, non-stopword)
  reconcilePlan(p, "migrate migrate migrate");
  assert.equal(p.steps[0].done, false);
});

test("reconcilePlan is a no-op on null plan or empty evidence", () => {
  assert.equal(reconcilePlan(null, "anything"), null);
  const p = parsePlan('["parse the input tokens"]');
  reconcilePlan(p, "");
  assert.equal(p.steps[0].done, false);
});

test("planNudgeBlock lists open items and is empty when all done", () => {
  const p = parsePlan("- [x] one thing\n- [ ] second thing here\n- [ ] third thing here");
  const block = planNudgeBlock(p);
  assert.match(block, /plan item still open: second thing here/);
  assert.match(block, /plan item still open: third thing here/);
  assert.doesNotMatch(block, /one thing/);

  const allDone = parsePlan("- [x] a\n- [x] b");
  assert.equal(planNudgeBlock(allDone), "");
  assert.equal(planNudgeBlock(null), "");
});

test("planNudgeBlock caps the number of surfaced items", () => {
  const p = parsePlan('["alpha step one", "beta step two", "gamma step three", "delta step four"]');
  const block = planNudgeBlock(p, { max: 2 });
  assert.equal((block.match(/plan item still open:/g) || []).length, 2);
});

test("buildPlanRequest produces a JSON-array instruction and carries the task", () => {
  const { system, user } = buildPlanRequest("implement feature X");
  assert.match(system, /JSON array/);
  assert.match(system, /do NOT write code/i);
  assert.match(user, /implement feature X/);
});
