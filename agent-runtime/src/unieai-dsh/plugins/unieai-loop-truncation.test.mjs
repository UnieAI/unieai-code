// Copyright (c) 2026 UnieAI. All rights reserved.
// Truncated tool calls: retry with a larger cap, then remind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import * as plugin from "./unieai-loop-truncation.mjs";
import { collect, fakeAgent, fakeContext, fromArray } from "./unieai-loop-testkit.mjs";

const toolChunks = (outputTokens) => [
  { type: "block-start", index: 0, blockType: "reasoning" },
  { type: "reasoning-delta", index: 0, text: "writing" },
  { type: "block-start", index: 1, blockType: "tool-call" },
  { type: "tool-call-delta", index: 1, id: "c1", name: "write", argumentsDelta: '{"path":"a.txt","content":"xxx' },
  { type: "usage", usage: { inputTokens: 900, cacheReadTokens: 100, outputTokens } },
  { type: "finish", reason: { kind: "max-tokens" } },
];

function setup({ contextWindow = 200_000, config = {} } = {}) {
  const agent = fakeAgent();
  const ctx = fakeContext({
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow } }) },
  });
  plugin.apply(ctx, config);
  const request = (turn, step, base) => ctx.waterfall("agent/request", { agent, turn, step, signal: AbortSignal.timeout(1000) }, async () => Object.freeze({ ...base }));
  const stream = (options, chunks) =>
    collect(ctx.waterfall("llm/stream", markAgentLoopRequest({ provider: "p", model: "m", messages: [], sessionId: agent.id, ...options }), () => fromArray(chunks)));
  const requestError = (failure) => ctx.waterfall("agent/request-error", { agent, turn: 1, step: 1, failure, provider: "p" }, async () => undefined);
  const stopping = (turn) => ctx.serial("agent/turn-stopping", { agent, turn, signal: new AbortController().signal });
  return { agent, ctx, request, stream, requestError, stopping };
}

test("nextMaxTokens grows the cap within the ceiling and the context window", () => {
  const base = { growth: 2, ceiling: 65536, reserve: 1024 };
  assert.equal(plugin.nextMaxTokens({ ...base, current: 256, usage: { outputTokens: 256 } }), 512);
  assert.equal(plugin.nextMaxTokens({ ...base, current: undefined, usage: { outputTokens: 4000 } }), 8000, "the observed output stands in for an unknown cap");
  assert.equal(plugin.nextMaxTokens({ ...base, current: 40000, usage: {} }), 65536);
  assert.equal(plugin.nextMaxTokens({ ...base, current: 65536, usage: {} }), null, "already at the ceiling");
  assert.equal(plugin.nextMaxTokens({ ...base, current: 1000, contextWindow: 3000, usage: { inputTokens: 1500, outputTokens: 1000 } }), null, "window leaves no room");
  assert.equal(plugin.nextMaxTokens({ ...base, current: 1000, contextWindow: 4000, usage: { inputTokens: 1500 } }), 1476);
  assert.equal(plugin.nextMaxTokens({ ...base, current: undefined, usage: undefined }), null);
});

test("a truncated tool call is retried with a larger cap, then reminded, then the cap is restored", async () => {
  const { agent, request, stream, requestError, stopping } = setup({ config: { maxRetries: 2 } });
  const base = { provider: "p", model: "m" }; // adapter default cap: not in the proposal

  assert.deepEqual(await request(1, 1, base), base);
  let out = await stream({ maxTokens: 256 }, toolChunks(256));
  assert.deepEqual(out.at(-1).reason.kind, "error");
  assert.equal(out.at(-1).reason.failure.code, plugin.TRUNCATED_CODE);
  assert.equal(out.filter((c) => c.type === "finish").length, 1, "exactly one terminal chunk");
  assert.deepEqual(await requestError(out.at(-1).reason.failure), { kind: "retry" });

  assert.equal((await request(1, 1, base)).maxTokens, 512, "retry of the same step gets the larger cap");
  out = await stream({ maxTokens: 512 }, toolChunks(512));
  assert.equal(out.at(-1).reason.failure.code, plugin.TRUNCATED_CODE);

  assert.equal((await request(1, 1, { ...base, maxTokens: 512 })).maxTokens, 1024);
  out = await stream({ maxTokens: 1024 }, toolChunks(1024));
  assert.equal(out.at(-1).reason.kind, "max-tokens", "retries exhausted: the truncation passes through");

  await stopping(1);
  assert.equal(agent.steered.length, 1);
  assert.equal(agent.steered[0].source.kind, "plugin");
  assert.equal(agent.steered[0].source.plugin, "unieai-loop-truncation");
  assert.match(agent.steered[0].content[0].text, /did NOT run/);

  // The reminder step: the logged header still carries the raised cap; it is restored.
  agent.inbox.nextStep.length = 0;
  const restored = await request(1, 2, { ...base, maxTokens: 1024 });
  assert.equal("maxTokens" in restored, false, "back to the adapter default");
  out = await stream({ maxTokens: 256 }, [{ type: "block-start", index: 0, blockType: "text" }, { type: "finish", reason: { kind: "stop" } }]);
  assert.equal(out.at(-1).reason.kind, "stop");
  await stopping(1);
  assert.equal(agent.steered.length, 1, "no reminder for a normal stop");
});

test("an explicit original cap is restored after the retried step", async () => {
  const { request, stream } = setup();
  const base = { provider: "p", model: "m", maxTokens: 300 };
  await request(3, 1, base);
  await stream({ maxTokens: 300 }, toolChunks(300));
  assert.equal((await request(3, 1, base)).maxTokens, 600);
  await stream({ maxTokens: 600 }, [{ type: "finish", reason: { kind: "tool-calls" } }]);
  assert.equal((await request(3, 2, { ...base, maxTokens: 600 })).maxTokens, 300);
});

test("text-only truncation, other failures and non-loop requests pass through", async () => {
  const { agent, ctx, request, stream, requestError, stopping } = setup();
  await request(1, 1, { provider: "p", model: "m" });
  const textOnly = [{ type: "block-start", index: 0, blockType: "text" }, { type: "text-delta", index: 0, text: "long" }, { type: "finish", reason: { kind: "max-tokens" } }];
  assert.equal((await stream({ maxTokens: 256 }, textOnly)).at(-1).reason.kind, "max-tokens");
  await stopping(1);
  assert.equal(agent.steered.length, 0);
  assert.equal(await requestError({ code: "SERVER", message: "boom" }), undefined);

  const unmarked = await collect(ctx.waterfall("llm/stream", { provider: "p", model: "m", sessionId: agent.id, maxTokens: 10 }, () => fromArray(toolChunks(10))));
  assert.equal(unmarked.at(-1).reason.kind, "max-tokens", "compaction/title calls are not agent-loop requests");
});

test("no retry when the context window leaves no room; the reminder still fires once per cap", async () => {
  const { agent, request, stream, stopping } = setup({ contextWindow: 1200, config: { maxReminders: 1 } });
  await request(1, 1, { provider: "p", model: "m" });
  const out = await stream({ maxTokens: 256 }, toolChunks(256));
  assert.equal(out.at(-1).reason.kind, "max-tokens");
  await stopping(1);
  assert.equal(agent.steered.length, 1);
  agent.inbox.nextStep.length = 0;
  await request(1, 2, { provider: "p", model: "m" });
  await stream({ maxTokens: 256 }, toolChunks(256));
  await stopping(1);
  assert.equal(agent.steered.length, 1, "maxReminders caps reminders per turn");
});

test("after a surfaced truncation, tool-call steps keep the sticky max-tokens turn going", async () => {
  const { agent, request, stream, stopping } = setup({ config: { maxRetries: 0, maxContinuations: 2 } });
  const { session } = agent;
  const assistant = (step, content) => session.append("assistant/message", { turn: 1, step, message: { role: "assistant", content }, stream: [] }, { surfaceOp: "append" });
  const toolCall = { type: "tool-call", id: "c", name: "write", arguments: "{}" };
  session.append("turn/start", { turn: 1 });
  const claim = () => (agent.inbox.nextStep.length = 0);

  await request(1, 1, { provider: "p", model: "m" });
  await stream({ maxTokens: 256 }, toolChunks(256));
  assistant(1, [{ type: "text", text: "writing" }]);
  await stopping(1);
  assert.match(agent.steered.at(-1).content[0].text, /did NOT run/, "step 1: reminder");
  claim();

  for (const step of [2, 3]) {
    await request(1, step, { provider: "p", model: "m" });
    await stream({ maxTokens: 256 }, [{ type: "finish", reason: { kind: "tool-calls" } }]);
    assistant(step, [toolCall]);
    await stopping(1);
    assert.equal(agent.steered.at(-1).content[0].text, plugin.CONTINUE, `step ${step}: continue`);
    claim();
  }
  await request(1, 4, { provider: "p", model: "m" });
  assistant(4, [toolCall]);
  await stopping(1);
  assert.equal(agent.steered.length, 3, "maxContinuations reached");

  // A final answer, or a tool that concluded the turn, ends it.
  const other = setup({ config: { maxRetries: 0 } });
  other.agent.session.append("turn/start", { turn: 1 });
  await other.request(1, 1, { provider: "p", model: "m" });
  await other.stream({ maxTokens: 256 }, [{ type: "block-start", index: 0, blockType: "text" }, { type: "finish", reason: { kind: "max-tokens" } }]);
  await other.request(1, 2, { provider: "p", model: "m" });
  other.agent.session.append("assistant/message", { turn: 1, step: 2, message: { role: "assistant", content: [toolCall] }, stream: [] });
  other.ctx.emit("tools/result", { agent: other.agent, name: "finish" }, { isError: false, concludesTurn: true });
  await other.stopping(1);
  assert.equal(other.agent.steered.length, 0, "a concluding tool ends the turn");
  await other.request(1, 3, { provider: "p", model: "m" });
  other.agent.session.append("assistant/message", { turn: 1, step: 3, message: { role: "assistant", content: [toolCall] }, stream: [] });
  await other.stopping(1);
  assert.equal(other.agent.steered.length, 1, "text-only truncation is sticky too");
  other.agent.inbox.nextStep.length = 0;
  await other.request(1, 4, { provider: "p", model: "m" });
  other.agent.session.append("assistant/message", { turn: 1, step: 4, message: { role: "assistant", content: [{ type: "text", text: "done" }] }, stream: [] });
  await other.stopping(1);
  assert.equal(other.agent.steered.length, 1);
});
