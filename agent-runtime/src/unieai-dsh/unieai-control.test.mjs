// Copyright (c) 2026 UnieAI. All rights reserved.
// History and fork boundaries from dsh session events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forkCut, historyFromEvents } from "./unieai-control.mjs";

let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: 1_700_000_000_000 + seq * 1000, data });
const user = (text, kind = "user") => ev("user/message", { content: [{ type: "text", text }], source: { kind } });

function session() {
  seq = 0;
  return [
    ev("request/header", {}),
    ev("turn/start", { turn: 1 }),
    user("<agents.md>", "plugin"),
    user("first"),
    ev("assistant/message", { message: { content: [{ type: "reasoning", text: "hm" }, { type: "text", text: "ok" }] } }),
    ev("tool/call", { callId: "c1", name: "bash", arguments: '{"command":"ls"}' }),
    ev("tool/result", { message: { content: [{ toolCallId: "c1", isError: false, content: [{ type: "text", text: "a.txt" }] }] } }),
    user("steer in turn 1"),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
    // A turn nobody prompted (e.g. a goal round) belongs to the turn before it.
    ev("turn/start", { turn: 2 }),
    user("continue", "goal"),
    ev("turn/end", { turn: 2, reason: { kind: "completed" } }),
    ev("turn/start", { turn: 3 }),
    user("second"),
    ev("assistant/message", { message: { content: [{ type: "text", text: "partial" }] } }),
    ev("turn/end", { turn: 3, reason: { kind: "interrupted" } }),
    ev("turn/start", { turn: 4 }),
    user("third, still running"),
  ];
}

test("history keeps only prompted turns, with their messages, tools and outcome", () => {
  const turns = historyFromEvents(session());
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[0].items.map((i) => i.type), ["user", "reasoning", "assistant", "tool", "user"]);
  assert.deepEqual(turns[0].items[3], { type: "tool", callId: "c1", name: "bash", arguments: '{"command":"ls"}', status: "completed", output: "a.txt" });
  assert.equal(turns[0].items[4].text, "steer in turn 1");
  assert.equal(turns[1].reason, "interrupted");
  assert.equal(turns[2].endSeq, null, "the running turn is open");
  assert.equal(turns[0].startedAt, 1_700_000_002);
});

test("a fork cuts at the next prompted turn, never inside an open one", () => {
  const events = session();
  const starts = events.filter((e) => e.type === "turn/start").map((e) => e.seq);
  assert.equal(forkCut(events, 0), starts[0], "nothing kept: stop before the first prompt");
  assert.equal(forkCut(events, 1), starts[2], "turn 1 keeps its goal round");
  assert.equal(forkCut(events, 2), starts[3]);
  assert.equal(forkCut(events, 3), null, "turn 3 has not ended");
  assert.equal(forkCut(events, 4), null);
  const finished = events.slice(0, -2);
  assert.equal(forkCut(finished, 2), finished.at(-1).seq + 1);
});

test("client tool specs flatten across namespaces; responses become MCP results", async () => {
  const { flattenClientTools, mcpResultOf } = await import("./unieai-control.mjs");
  const specs = [
    { type: "namespace", name: "codex_tui", description: "", tools: [
      { type: "function", name: "list_peers", description: "List peers", inputSchema: { type: "object", properties: {} } },
      { type: "function", name: "broken" },
    ] },
    { type: "function", name: "solo", description: "", inputSchema: { type: "object" } },
  ];
  assert.deepEqual(flattenClientTools(specs), [
    { name: "list_peers", description: "List peers", inputSchema: { type: "object", properties: {} }, namespace: "codex_tui" },
    { name: "solo", description: "", inputSchema: { type: "object" }, namespace: null },
  ]);
  assert.deepEqual(flattenClientTools(null), []);
  assert.deepEqual(
    mcpResultOf({ contentItems: [{ type: "inputText", text: "a" }, { type: "inputImage", imageUrl: "data:x" }], success: true }),
    { content: [{ type: "text", text: "a" }, { type: "text", text: "[image: data:x]" }], isError: false },
  );
  assert.equal(mcpResultOf({ contentItems: [], success: false }).isError, true);
});

test("token usage: totals and the last model call, in the protocol's shape", async () => {
  const { usageFromEvents } = await import("./unieai-control.mjs");
  const events = [
    { type: "user/message", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } } },
    { type: "tool/result", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 1500, outputTokens: 5, cacheReadTokens: 900, totalTokens: 1505 } } },
    { type: "assistant/message", data: {} },
  ];
  assert.deepEqual(usageFromEvents(events), {
    total: { totalTokens: 2525, inputTokens: 2500, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 25, reasoningOutputTokens: 0 },
    last: { totalTokens: 1505, inputTokens: 1500, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
  });
});

test("a steered message is reported to the client when the model takes it, not when queued", async () => {
  const { apply } = await import("./unieai-control.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { connect } = await import("node:net");
  const { createInterface } = await import("node:readline");
  const handlers = {};
  const steered = [];
  const agent = { id: "s1", session: { header: { id: "s1" } }, steer: (message) => steered.push(message) };
  const socket = join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock");
  apply(
    { on: (name, fn) => (handlers[name] = fn), agents: { get: (id) => (id === "s1" ? agent : undefined) }, logger: { warn() {}, info() {} }, effect: () => {} },
    { socket },
  );
  await new Promise((r) => setTimeout(r, 50));
  const client = connect(socket);
  const lines = [];
  createInterface({ input: client }).on("line", (line) => lines.push(JSON.parse(line)));
  client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "steer", params: { sessionId: "s1", text: "also this", clientId: "c-42" } })}\n`);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(steered.length, 1);
  assert.deepEqual(lines.filter((m) => m.method), [], "queued, not yet delivered");
  handlers["session/event"](agent.session, { type: "user/message", data: { content: [{ type: "text", text: "unrelated" }] } });
  handlers["session/event"](agent.session, { type: "user/message", data: { content: [{ type: "text", text: "also this" }] } });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lines.filter((m) => m.method), [{ jsonrpc: "2.0", method: "steerDelivered", params: { sessionId: "s1", clientId: "c-42", text: "also this" } }]);
  client.destroy();
  handlers.dispose();
});
