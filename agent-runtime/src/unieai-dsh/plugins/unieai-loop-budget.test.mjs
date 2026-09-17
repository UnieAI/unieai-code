// Copyright (c) 2026 UnieAI. All rights reserved.
// Turn budget: warn, then end the turn; skip retries near the deadline.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "./unieai-loop-budget.mjs";
import { fakeAgent, fakeContext } from "./unieai-loop-testkit.mjs";

function setup(config, env = {}) {
  let clock = 1_000_000;
  const agent = fakeAgent();
  const ctx = fakeContext();
  plugin.apply(ctx, config, { now: () => clock, env });
  const preStep = (turn, step, messages = []) =>
    ctx.waterfall("agent/pre-step", { agent, turn, step, messages, signal: new AbortController().signal }, async () => ({ kind: "enter", messages }));
  const requestError = (turn) => ctx.waterfall("agent/request-error", { agent, turn, step: 1, failure: { code: "SERVER" } }, async () => ({ kind: "retry" }));
  return { agent, ctx, preStep, requestError, tick: (ms) => (clock += ms), idle: () => ctx.emit("agent/status", { agent, status: "idle" }) };
}

test("resolveConfig reads env and treats unset as unlimited", () => {
  assert.equal(plugin.resolveConfig({}, {}).deadlineMs, 0);
  assert.equal(plugin.resolveConfig({}, { UNIEAI_TURN_DEADLINE_MS: "60000" }).deadlineMs, 60000);
  assert.equal(plugin.resolveConfig({ deadlineMs: 5000 }, { UNIEAI_TURN_DEADLINE_MS: "60000" }).deadlineMs, 5000);
  assert.equal(plugin.resolveConfig({}, { UNIEAI_TURN_MAX_STEPS: "abc" }).maxSteps, 0);
});

test("without a budget the plugin registers nothing", () => {
  const { ctx } = setup({}, {});
  assert.equal(ctx.listeners("agent/pre-step").length, 0);
});

test("deadline: one wrap-up reminder, then the turn is rejected; retries stop near the end", async () => {
  const { agent, preStep, requestError, tick, idle } = setup({}, { UNIEAI_TURN_DEADLINE_MS: "100000" });
  const first = await preStep(1, 1, [{ id: "u", source: { kind: "user" } }]);
  assert.equal(first.messages.length, 1);
  assert.deepEqual(await requestError(1), { kind: "retry" }, "plenty of time: llm-retry decides");

  tick(85_000);
  const warned = await preStep(1, 2);
  assert.equal(warned.messages.length, 1);
  assert.equal(warned.messages[0].source.plugin, "unieai-loop-budget");
  assert.match(warned.messages[0].content[0].text, /about 15 seconds/);
  assert.equal((await preStep(1, 3)).messages.length, 0, "warned once");
  assert.equal(await requestError(1), undefined, "too little time left to back off");

  tick(20_000);
  assert.deepEqual(await preStep(1, 4), { kind: "reject" });
  idle();
  assert.equal(agent.cancelled.length, 0);

  const next = await preStep(2, 1, [{ id: "u2", source: { kind: "user" } }]);
  assert.equal(next.kind, "enter", "a new turn gets a fresh budget");
  idle();
});

test("steps: warn near the cap, reject past it; a message-less first step is not extended", async () => {
  const { preStep, idle } = setup({ maxSteps: 6, warnSteps: 2 });
  assert.equal((await preStep(1, 1)).messages.length, 0);
  assert.equal((await preStep(1, 4)).messages.length, 0);
  assert.equal((await preStep(1, 5)).messages.length, 1, "2 steps left including this one");
  assert.equal((await preStep(1, 6)).kind, "enter");
  assert.deepEqual(await preStep(1, 7), { kind: "reject" });
  idle();
});

test("the deadline timer cancels a step that overruns", async () => {
  const { agent, preStep } = setup({ deadlineMs: 20, cancelGraceMs: 1 });
  await preStep(1, 1, [{ id: "u", source: { kind: "user" } }]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(agent.cancelled, [{ kind: "hook", reason: "unieai turn deadline reached" }]);
});
