// Copyright (c) 2026 UnieAI. All rights reserved.
// History and fork boundaries from dsh session events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forkCut, historyFromEvents, rewindRequest } from "./unieai-control.mjs";

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

test("every dsh turn on its own: its number, what opened it, and a scheduled prompt as its user message", () => {
  const events = session();
  events.splice(12, 0, ...[
    ev("turn/start", { turn: 9 }),
    { type: "user/message", seq: 0, time: 0, data: { content: [{ type: "text", text: "<scheduled>long" }], source: { kind: "unieai-schedule", summary: "[scheduled] check CI" } } },
    ev("turn/end", { turn: 9, reason: { kind: "completed" } }),
  ]);
  events.forEach((event, index) => (event.seq = index));
  const turns = historyFromEvents(events, { everyTurn: true });
  assert.deepEqual(turns.map((t) => [t.dshTurn, t.opener]), [[1, "user"], [2, null], [9, "scheduled"], [3, "user"], [4, "user"]]);
  assert.deepEqual(turns[0].items.map((i) => i.type), ["user", "reasoning", "assistant", "tool", "user"], "a steer does not change the opener");
  assert.deepEqual(turns[2].items, [{ type: "user", text: "[scheduled] check CI" }]);
  assert.ok(!("answered" in turns[0]));
  const starts = events.filter((e) => e.type === "turn/start").map((e) => e.seq);
  assert.equal(forkCut(events, 1, { everyTurn: true }), starts[1], "the goal round is a turn of its own here");
  assert.equal(forkCut(events, 3, { everyTurn: true }), starts[3]);
  assert.equal(forkCut(events, 4, { everyTurn: true }), starts[4]);
  assert.equal(forkCut(events, 5, { everyTurn: true }), null, "turn 4 has not ended");
  const request = rewindRequest({ events }, 2, { everyTurn: true });
  assert.equal(events[request.fromSeq].data.turn, 9);
  assert.equal(historyFromEvents(events).length, 3, "the default still counts user turns");
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

test("a billing refusal is not retried; other request failures go on to llm-retry", async () => {
  const { apply } = await import("./unieai-control.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const handlers = {};
  const options = {};
  apply(
    {
      on: (name, fn, opts) => {
        handlers[name] = fn;
        options[name] = opts;
      },
      agents: { get: () => undefined },
      logger: { warn() {}, info() {} },
      effect: () => {},
    },
    { socket: join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock") },
  );
  assert.deepEqual(options["agent/request-error"], { prepend: true }, "ahead of llm-retry");
  let delegated = 0;
  const next = async () => {
    delegated += 1;
    return { kind: "retry" };
  };
  const billing = { failure: { code: "RATE_LIMIT", message: '429 {"error":{"code":"plan_limit_reached","window":"week"}}' } };
  assert.equal(await handlers["agent/request-error"](billing, next), undefined);
  assert.equal(delegated, 0);
  const transient = { failure: { code: "RATE_LIMIT", message: "429 Too Many Requests" } };
  assert.deepEqual(await handlers["agent/request-error"](transient, next), { kind: "retry" });
  assert.equal(delegated, 1);
  handlers.dispose();
});

test("a rewind starts at the first undone user turn, so a goal round before it is kept", () => {
  const events = session();
  const observed = { header: { cwd: "/w" }, events };
  // Undoing "second" (user turn 1) starts at dsh turn 3, after turn 1's goal round.
  const request = rewindRequest(observed, 1);
  assert.equal(request.cwd, "/w");
  assert.equal(request.events, events);
  assert.equal(events[request.fromSeq].type, "turn/start");
  assert.equal(events[request.fromSeq].data.turn, 3);
  assert.equal(events[rewindRequest(observed, 0).fromSeq].data.turn, 1);
  assert.equal(rewindRequest(observed, 3), null, "no such turn");
});

test("/context: the plugin measures the session, counting the client's registered tools as its own", async () => {
  const { apply } = await import("./unieai-control.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { connect } = await import("node:net");
  const { createInterface } = await import("node:readline");
  const handlers = {};
  const measured = [];
  const parent = { id: "p1", session: { header: { id: "p1" } }, ctx: { tools: { register: () => () => {} } } };
  const child = { id: "c1", session: { header: { id: "c1", parentSession: "p1" } } };
  const agents = { p1: parent, c1: child };
  const service = { measure: async (agent, options) => (measured.push([agent.id, options]), { totalTokens: 42 }) };
  const socket = join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock");
  let loaded = true;
  apply(
    {
      on: (name, fn) => (handlers[name] = fn),
      get: (name) => (name === "unieaiContextUsage" && loaded ? service : undefined),
      agents: { get: (id) => agents[id] },
      logger: { warn() {}, info() {} },
      effect: () => {},
    },
    { socket },
  );
  await new Promise((r) => setTimeout(r, 50));
  const client = connect(socket);
  const replies = new Map();
  createInterface({ input: client }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.set(message.id, message);
  });
  const call = async (id, method, params) => {
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    return replies.get(id);
  };
  const tool = { type: "function", name: "list_threads", description: "", inputSchema: { type: "object" } };
  assert.deepEqual((await call(1, "registerTools", { sessionId: "p1", tools: [tool] })).result, { registered: 1 });
  assert.deepEqual((await call(2, "context", { sessionId: "p1" })).result, { totalTokens: 42 });
  await call(3, "context", { sessionId: "c1" });
  assert.deepEqual(measured, [["p1", { clientToolNames: ["list_threads"] }], ["c1", { clientToolNames: ["list_threads"] }]]);
  loaded = false;
  assert.match((await call(4, "context", { sessionId: "p1" })).error.message, /unieai-context-usage plugin is not loaded/);
  assert.match((await call(5, "context", { sessionId: "gone" })).error.message, /not open/);
  client.destroy();
  handlers.dispose();
});
