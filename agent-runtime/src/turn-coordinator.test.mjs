import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnCoordinator } from "./turn-coordinator.mjs";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("same key: concurrent runs execute serially, not interleaved", async () => {
  const c = createTurnCoordinator();
  const order = [];
  const p1 = c.run("s", async () => { order.push("1-start"); await tick(20); order.push("1-end"); return 1; });
  const p2 = c.run("s", async () => { order.push("2-start"); await tick(5); order.push("2-end"); return 2; });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(order, ["1-start", "1-end", "2-start", "2-end"], "second waits for the first");
});

test("different keys run concurrently", async () => {
  const c = createTurnCoordinator();
  const order = [];
  const a = c.run("a", async () => { order.push("a-start"); await tick(20); order.push("a-end"); });
  const b = c.run("b", async () => { order.push("b-start"); await tick(5); order.push("b-end"); });
  await Promise.all([a, b]);
  // b finishes before a → they overlapped.
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("a failing turn does not wedge the queue", async () => {
  const c = createTurnCoordinator();
  const p1 = c.run("s", async () => { await tick(5); throw new Error("boom"); });
  const p2 = c.run("s", async () => "after-failure");
  await assert.rejects(p1, /boom/);
  assert.equal(await p2, "after-failure");
});

test("isBusy reflects the chain, clears when idle", async () => {
  const c = createTurnCoordinator();
  assert.equal(c.isBusy("s"), false);
  const p = c.run("s", async () => { await tick(10); });
  assert.equal(c.isBusy("s"), true);
  await p;
  await tick(1); // let the self-clean settle
  assert.equal(c.isBusy("s"), false);
});

test("queueNext coalesces a single follow-up that drains after the active run", async () => {
  const c = createTurnCoordinator();
  const order = [];
  const active = c.run("s", async () => { order.push("active-start"); await tick(20); order.push("active-end"); });
  // Two queued follow-ups while active is running: only the LAST is kept.
  c.queueNext("s", async () => { order.push("drop-me"); });
  c.queueNext("s", async () => { order.push("keep-me"); });
  await active;
  await tick(10);
  assert.deepEqual(order, ["active-start", "active-end", "keep-me"], "coalesced to the last follow-up");
});
