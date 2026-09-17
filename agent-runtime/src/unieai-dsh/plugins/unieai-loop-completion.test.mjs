// Copyright (c) 2026 UnieAI. All rights reserved.
// Completion guard: empty and announce-only stops get a bounded continuation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "./unieai-loop-completion.mjs";
import { fakeAgent, fakeContext, fakeSession } from "./unieai-loop-testkit.mjs";

const assistant = (turn, content, extra = {}) => ["assistant/message", { turn, step: 1, message: { role: "assistant", content }, stream: [], ...extra }];
const text = (t) => ({ type: "text", text: t });
const reasoning = (t) => ({ type: "reasoning", text: t });

test("announcesAction recognizes hand-offs and ignores answers", () => {
  for (const yes of [
    "I found the bug in parser.py. Let me fix it:",
    "Now I'll update the test file.",
    "Okay, next I will run the test suite.",
    "問題在 config.js。讓我修改它。",
    "好的，我将修改 main.py 来修复这个问题",
    "Some long analysis. ".repeat(60) + "\n\nLet me apply the patch:",
  ]) assert.equal(plugin.announcesAction(yes), true, yes);
  for (const no of [
    "The fix is in place and all tests pass.",
    "Done. Let me know if you need anything else.",
    "Should I also update the docs?",
    "I will not change the public API.".replace("I will not", "We kept"),
    "Some long analysis. ".repeat(60) + "\n\nI'll leave the remaining refactor for later.",
    "已完成修改，测试全部通过。",
  ]) assert.equal(plugin.announcesAction(no), false, no);
});

test("classifyStop", () => {
  assert.equal(plugin.classifyStop(assistant(1, [reasoning("thinking")])[1]).kind, "empty");
  assert.equal(plugin.classifyStop(assistant(1, [text("   ")])[1]).kind, "empty");
  assert.equal(plugin.classifyStop(assistant(1, [text("Let me check the file.")])[1]).kind, "announce");
  assert.equal(plugin.classifyStop(assistant(1, [text("Let me check."), { type: "tool-call", id: "c", name: "read", arguments: "{}" }])[1]), null);
  assert.equal(plugin.classifyStop(assistant(1, [text("All done.")])[1]), null);
  assert.equal(plugin.classifyStop(assistant(1, [], { interrupted: true })[1]), null);
  assert.equal(plugin.classifyStop(undefined), null);
});

function setup(events, config) {
  const session = fakeSession([["turn/start", { turn: 1 }], ["user/message", { role: "user", content: [text("fix it")], source: { kind: "user" } }], ...events]);
  const agent = fakeAgent({ session });
  const ctx = fakeContext();
  plugin.apply(ctx, config);
  const stopping = (turn = 1, signal = new AbortController().signal) => ctx.serial("agent/turn-stopping", { agent, turn, signal });
  const respond = (content) => {
    agent.inbox.nextStep.length = 0; // the loop claimed the steer
    session.append(...assistant(1, content), { surfaceOp: "append" });
  };
  return { agent, session, stopping, respond };
}

test("a reasoning-only stop is continued, with a per-turn cap and fingerprint de-dup", async () => {
  const { agent, stopping, respond } = setup([assistant(1, [reasoning("I should edit a.py")])], { maxNudges: 2 });
  await stopping();
  assert.equal(agent.steered.length, 1);
  assert.equal(agent.steered[0].source.plugin, "unieai-loop-completion");
  assert.match(agent.steered[0].content[0].text, /no answer text and no tool call/);

  respond([reasoning("I should edit a.py")]); // identical: the model is stuck, let it stop
  await stopping();
  assert.equal(agent.steered.length, 1);

  respond([text("Let me edit a.py now.")]);
  await stopping();
  assert.equal(agent.steered.length, 2);
  assert.match(agent.steered[1].content[0].text, /did not call a tool/);

  respond([reasoning("different thought")]);
  await stopping();
  assert.equal(agent.steered.length, 2, "cap reached for this turn");
});

test("a real answer, pending steering, an aborted turn or no assistant message stop normally", async () => {
  const answered = setup([assistant(1, [text("Fixed; tests pass.")])]);
  await answered.stopping();
  assert.equal(answered.agent.steered.length, 0);

  const busy = setup([assistant(1, [reasoning("x")])]);
  busy.agent.inbox.nextStep.push({});
  await busy.stopping();
  assert.equal(busy.agent.steered.length, 0);

  const aborted = setup([assistant(1, [reasoning("x")])]);
  const controller = new AbortController();
  controller.abort();
  await aborted.stopping(1, controller.signal);
  assert.equal(aborted.agent.steered.length, 0);

  const none = setup([]);
  await none.stopping();
  assert.equal(none.agent.steered.length, 0);
});

test("only the current turn's message counts, and the cap resets per turn", async () => {
  const { agent, session, stopping } = setup([assistant(1, [reasoning("x")]), ["turn/end", { turn: 1 }]], { maxNudges: 1 });
  await stopping(1);
  assert.equal(agent.steered.length, 1);
  agent.inbox.nextStep.length = 0;
  session.append("turn/start", { turn: 2 });
  await stopping(2);
  assert.equal(agent.steered.length, 1, "turn 2 has no assistant message yet");
  session.append(...assistant(2, [reasoning("y")]), { surfaceOp: "append" });
  await stopping(2);
  assert.equal(agent.steered.length, 2);
});
