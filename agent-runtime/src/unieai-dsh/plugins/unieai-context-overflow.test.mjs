// Copyright (c) 2026 UnieAI. All rights reserved.
// Compaction summary overflow: shed the oldest tool outputs and retry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError } from "@deepseek-ai/dsh-llm";
import * as plugin from "./unieai-context-overflow.mjs";
import { fakeContext, fakeSession } from "./unieai-loop-testkit.mjs";

const estimate = (message) => Math.ceil(JSON.stringify(message.content).length / 4);
const user = (t) => ["user/message", { role: "user", content: [{ type: "text", text: t }], source: { kind: "user" } }];
const call = (id) => ["assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "tool-call", id, name: "bash", arguments: "{}" }] } }];
const result = (id, size) => [
  "tool/result",
  {
    turn: 1,
    step: 1,
    message: { role: "user", source: { kind: "tool", callId: id }, content: [{ type: "tool-result", toolCallId: id, isError: false, content: [{ type: "text", text: "x".repeat(size) }] }] },
  },
];

function span() {
  const session = fakeSession([
    ["system/message", { message: { role: "system", content: [{ type: "text", text: "sys" }] } }],
    user("task"),
    call("a"), result("a", 4000),
    call("b"), result("b", 4000),
    call("c"), result("c", 4000),
    call("d"), result("d", 4000),
  ]);
  return { session, seqs: session.surface.nodes.slice(1) };
}

const toolText = (session, seq) => session.eventAt(seq).data.message.content[0].content[0].text;

test("isOverflowError", () => {
  assert.equal(plugin.isOverflowError(new LlmError("too big", "CONTEXT_WINDOW_EXCEEDED")), true);
  assert.equal(plugin.isOverflowError(Object.assign(new Error("x"), { code: "CONTEXT_WINDOW_EXCEEDED" })), true);
  assert.equal(plugin.isOverflowError(new Error("This model's maximum context length is 8192 tokens")), true);
  assert.equal(plugin.isOverflowError(new LlmError("slow", "TIMEOUT")), false);
  assert.equal(plugin.isOverflowError(Object.assign(new Error("summarization truncated"), { code: "MAX_TOKENS" })), false);
  assert.equal(plugin.isOverflowError(undefined), false);
});

test("sheds the oldest tool outputs with the pruner's durable protocol", () => {
  const { session, seqs } = span();
  const before = session.events.length;
  const replaced = plugin.shedOldestToolOutputs(session, seqs, estimate, 0.25);
  // Four ~1000-token outputs: a quarter of the span takes two stubs (each saves a bit less than 1000).
  assert.equal(replaced, 2);
  const added = session.events.slice(before);
  assert.deepEqual(added.map((e) => e.type), ["compaction/prune", "tool/result", "compaction/prune", "tool/result"]);
  const oldest = seqs[2];
  assert.deepEqual(added[0].data.shadowedSeqs, [oldest]);
  assert.ok(added[0].data.shadowedTokenCount > 1000);
  assert.equal(added[1].data.message.content[0].toolCallId, "a", "call pairing is kept");
  assert.equal(toolText(session, added[1].seq), plugin.STUB_TEXT);
  assert.ok(Object.isFrozen(added[1].data.message));
  assert.equal(session.surface.nodes.includes(oldest), false);
  assert.equal(session.surface.nodes[3], added[1].seq, "replacement keeps the position");
  assert.equal(added[3].data.message.content[0].toolCallId, "b", "oldest first");
});

test("span ends are never replaced, stubs are not re-stubbed, and it runs dry", () => {
  const session = fakeSession([call("a"), result("a", 4000), call("b"), result("b", 4000)]);
  let seqs = [...session.surface.nodes];
  assert.equal(seqs.at(-1), 3);
  let rounds = 0;
  while (plugin.shedOldestToolOutputs(session, seqs, estimate, 0.25) > 0) {
    seqs = [...session.surface.nodes];
    rounds += 1;
    assert.ok(rounds < 10);
  }
  assert.equal(rounds, 1, "only the inner output can go");
  assert.equal(toolText(session, seqs.at(-1)).length, 4000, "the last node (span end) is untouched");
});

test("the summary-error listener recovers overflow only, and delegates when stuck", () => {
  const { session, seqs } = span();
  const ctx = fakeContext({ tokenMeter: { estimateMessage: estimate } });
  plugin.apply(ctx, { dropRatio: 0.5 });
  const fire = (error, sourceEventSeqs = seqs) => ctx.waterfall("compaction/summary-error", { session, sourceEventSeqs, error }, () => false);

  assert.equal(fire(new LlmError("slow", "TIMEOUT")), false);
  assert.equal(fire(new LlmError("too long", "CONTEXT_WINDOW_EXCEEDED")), true);
  assert.equal(session.events.filter((e) => e.type === "compaction/prune").length, 3, "half the span: three outputs");
  assert.match(ctx.logs.at(-1)[1], /dropped 3 oldest tool output/);
  assert.equal(fire(new LlmError("too long", "CONTEXT_WINDOW_EXCEEDED"), session.surface.nodes.slice(1)), false, "only the span end is left");

  const aborted = new AbortController();
  aborted.abort(new Error("stop"));
  assert.throws(() => ctx.waterfall("compaction/summary-error", { session, sourceEventSeqs: seqs, error: new LlmError("x", "CONTEXT_WINDOW_EXCEEDED"), signal: aborted.signal }, () => false), /stop/);
});
