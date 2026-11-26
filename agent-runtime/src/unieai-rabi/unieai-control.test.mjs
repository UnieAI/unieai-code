// Copyright (c) 2026 UnieAI. All rights reserved.
// History and fork boundaries from rabi session events.
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

test("every rabi turn on its own: its number, what opened it, and a scheduled prompt as its user message", () => {
  const events = session();
  events.splice(12, 0, ...[
    ev("turn/start", { turn: 9 }),
    { type: "user/message", seq: 0, time: 0, data: { content: [{ type: "text", text: "<scheduled>long" }], source: { kind: "unieai-schedule", summary: "[scheduled] check CI" } } },
    ev("turn/end", { turn: 9, reason: { kind: "completed" } }),
  ]);
  events.forEach((event, index) => (event.seq = index));
  const turns = historyFromEvents(events, { everyTurn: true });
  assert.deepEqual(turns.map((t) => [t.rabiTurn, t.opener]), [[1, "user"], [2, null], [9, "scheduled"], [3, "user"], [4, "user"]]);
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
  // Undoing "second" (user turn 1) starts at rabi turn 3, after turn 1's goal round.
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

/** The control plugin on a socket, with a client that calls it and collects its notes. */
async function controlClient(ctxExtras) {
  const { apply } = await import("./unieai-control.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { connect } = await import("node:net");
  const { createInterface } = await import("node:readline");
  const handlers = {};
  const socket = join(mkdtempSync(join(tmpdir(), "ctl-")), "c.sock");
  apply({ on: (name, fn) => (handlers[name] = fn), logger: { warn() {}, info() {} }, effect: () => {}, ...ctxExtras }, { socket });
  await new Promise((r) => setTimeout(r, 50));
  const client = connect(socket);
  const replies = new Map();
  const notes = [];
  createInterface({ input: client }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.set(message.id, message);
    else notes.push(message);
  });
  let nextId = 0;
  const call = async (method, params) => {
    const id = (nextId += 1);
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    return replies.get(id);
  };
  const close = () => {
    client.destroy();
    handlers.dispose();
  };
  return { call, notes, close };
}

/** A handle as unieai-exec publishes it, over a process that exits on `exit(code)`. */
function fakeHandle(id, cmd) {
  let settle;
  const exited = new Promise((resolve) => (settle = resolve));
  const handle = {
    id,
    cmd,
    cwd: "/work",
    tty: false,
    startedAt: 1_700_000_000_000,
    backgroundedAt: 1_700_000_010_000,
    running: true,
    exitCode: null,
    killed: false,
    whenExited: async (_ms, signal) => Promise.race([exited, new Promise((resolve) => signal?.addEventListener("abort", () => resolve(false)))]),
    peek: (maxBytes) => "line 1\nline 2\n".slice(-maxBytes),
    kill: async () => {
      handle.killed = true;
      handle.exit(143);
    },
    exit: (code) => {
      handle.running = false;
      handle.exitCode = code;
      settle(true);
    },
  };
  return handle;
}

test("exec sessions left running: announced, listed per session tree, read without taking, stopped", async () => {
  const { publishBackground } = await import("./uac-plugins/unieai-exec-state.mjs");
  const parent = { id: "p1", session: { header: { id: "p1" } } };
  const child = { id: "c1", session: { header: { id: "c1", parentSession: "p1" } } };
  const other = { id: "o1", session: { header: { id: "o1" } } };
  const agents = { p1: parent, c1: child, o1: other };
  const { call, notes, close } = await controlClient({ agents: { get: (id) => agents[id] } });
  // Any call makes the caller the bridge that hears notes.
  await call("execSessions", {});

  const mine = fakeHandle(1000, "sleep 120");
  const childs = fakeHandle(1001, "make test");
  const theirs = fakeHandle(1002, "npm run dev");
  publishBackground(parent, mine);
  publishBackground(child, childs);
  publishBackground(other, theirs);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    notes.filter((note) => note.method === "execSession").map(({ params }) => [params.phase, params.sessionId, params.id, params.cmd, params.parentSessionId]),
    [
      ["start", "p1", 1000, "sleep 120", null],
      ["start", "c1", 1001, "make test", "p1"],
      ["start", "o1", 1002, "npm run dev", null],
    ],
  );

  const listed = (await call("execSessions", { sessionId: "p1" })).result.sessions;
  assert.deepEqual(listed.map((session) => [session.sessionId, session.id, session.cwd, session.running]), [
    ["p1", 1000, "/work", true],
    ["c1", 1001, "/work", true],
  ]);
  assert.deepEqual((await call("execSessions", { sessionId: "c1" })).result.sessions.map((session) => session.id), [1001]);

  const output = (await call("execOutput", { id: 1000, maxBytes: 7 })).result;
  assert.deepEqual([output.id, output.output, output.running], [1000, "line 2\n", true]);
  assert.match((await call("execOutput", { id: 4242 })).error.message, /no background exec session 4242/);

  assert.deepEqual((await call("execKill", { id: 1000 })).result, { killed: true });
  childs.exit(0);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(
    notes.filter((note) => note.params?.phase === "end").map(({ params }) => [params.id, params.exitCode, params.killed]),
    [
      [1000, 143, true],
      [1001, 0, false],
    ],
  );
  // Ended sessions leave the list.
  assert.deepEqual((await call("execSessions", { sessionId: "p1" })).result.sessions, []);
  assert.match((await call("execKill", { id: 1000 })).error.message, /no background exec session/);
  close();
});

test("stopping a subagent interrupts it as the user, under its direct parent", async () => {
  const interrupts = [];
  const child = { id: "c1", session: { header: { id: "c1", parentSession: "p1" } } };
  const { call, close } = await controlClient({
    agents: { get: (id) => (id === "c1" ? child : undefined) },
    get: (name) => (name === "subagents" ? { interrupt: (id, authority) => interrupts.push([id, authority]) } : undefined),
  });
  assert.deepEqual((await call("subagentInterrupt", { sessionId: "c1" })).result, { interrupted: true });
  assert.deepEqual(interrupts, [["c1", { kind: "user", parentSessionId: "p1" }]]);
  assert.match((await call("subagentInterrupt", { sessionId: "p9" })).error.message, /not a subagent/);
  close();
});

test("a tool result fills in its call, in rabi 0.2.2's shape and the older one", () => {
  const run = (result) => {
    seq = 0;
    return historyFromEvents([
      ev("turn/start", { turn: 1 }),
      user("go"),
      ev("tool/call", { callId: "c1", name: "bash", arguments: "{}" }),
      ev("tool/call", { callId: "c2", name: "bash", arguments: "{}" }),
      ev("tool/result", result("c1", false, "out one")),
      ev("tool/result", result("c2", true, "boom")),
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
    ])[0].items.filter((item) => item.type === "tool");
  };
  const expected = [
    { type: "tool", callId: "c1", name: "bash", arguments: "{}", status: "completed", output: "out one" },
    { type: "tool", callId: "c2", name: "bash", arguments: "{}", status: "failed", output: "boom" },
  ];
  // 0.2.2: the tool message itself.
  assert.deepEqual(run((id, isError, text) => ({ message: { role: "tool", source: { kind: "tool", callId: id }, toolCallId: id, content: [{ type: "text", text }], isError } })), expected);
  // Before: the result as the message's first content block.
  assert.deepEqual(run((id, isError, text) => ({ message: { content: [{ toolCallId: id, isError, content: [{ type: "text", text }] }] } })), expected);
});

test("a ranged history read sends every turn's outline and only the range's items", async () => {
  const { historyAnswer, historyNeedsItems, turnOutline } = await import("./unieai-control.mjs");
  const turns = historyFromEvents(session(), { everyTurn: true });
  assert.deepEqual(historyAnswer(turns), { turns }, "no range: everything, as before");
  const { turns: ranged } = historyAnswer(turns, { from: 1, to: 2 });
  assert.equal(ranged.length, turns.length);
  assert.deepEqual(ranged.map((t) => Boolean(t.items)), [false, true, false, false]);
  assert.deepEqual(ranged[1].items, turns[1].items);
  assert.equal(ranged[0].itemCount, 5);
  assert.deepEqual(ranged[0].summary, { firstUser: { index: 0, item: turns[0].items[0] }, lastAssistant: { index: 2, item: turns[0].items[2] } });
  assert.deepEqual(turnOutline(turns[3]).summary, { firstUser: { index: 0, item: { type: "user", text: "third, still running" } }, lastAssistant: null });
  assert.equal(historyAnswer(turns, { from: 2, to: null }).turns.filter((t) => t.items).length, 2, "to null runs to the end");
  assert.equal(historyNeedsItems({}), true);
  assert.equal(historyNeedsItems({ from: 0, to: 0 }), false);
  assert.equal(historyNeedsItems({ from: 3, to: null }), true);
});

test("the history cache answers while the session's version holds, and keeps items for the newest few", async () => {
  const { createHistoryCache } = await import("./unieai-control.mjs");
  const cache = createHistoryCache({ full: 2, outlines: 3 });
  const turns = (n) => [{ rabiTurn: n, items: [{ type: "user", text: `t${n}` }] }];
  cache.set("a", true, "v1", turns(1), null);
  assert.equal(cache.get("a", true, "v1").turns[0].rabiTurn, 1);
  assert.equal(cache.get("a", true, "v2"), null, "the log grew");
  assert.equal(cache.get("a", false, "v1"), null, "user turns and every turn are different reads");
  assert.equal(cache.get("a", true, null), null, "an unknown version is never a hit");
  cache.set("b", true, "v1", turns(2), null);
  cache.set("c", true, "v1", turns(3), { id: "g" });
  const oldest = cache.get("a", true, "v1");
  assert.equal(oldest.turns, null, "past the newest two, only outlines");
  assert.equal(oldest.outlines[0].itemCount, 1);
  assert.deepEqual(cache.get("c", true, "v1").goal, { id: "g" });
  cache.set("d", true, "v1", turns(4), null);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("b", true, "v1"), null, "the least recently used went");
  const unversioned = cache.set("e", true, null, turns(5), null);
  assert.equal(unversioned.turns[0].rabiTurn, 5);
  assert.equal(cache.size, 3, "nothing kept without a version");
  cache.drop("d");
  assert.equal(cache.get("d", true, "v1"), null);
});

test("a stored session's goal comes from its log", async () => {
  const { storedGoal } = await import("./unieai-control.mjs");
  assert.equal(storedGoal(session()), null);
  seq = 0;
  const goal = { id: "g1", revision: 1, objective: "ship it", phase: "active", maxGoalRounds: 8 };
  const change = (operation, snapshot, roundsStarted, at) => ev("goal/change", { kind: "goal/change", version: 1, operation, goal: snapshot, roundsStarted, createdAt: 100, updatedAt: at });
  const events = [
    change("create", goal, 0, 100),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { content: [{ type: "text", text: "continue" }], source: { kind: "goal", goalId: "g1", revision: 1, round: 1 } }),
    ev("turn/end", { turn: 1, reason: { kind: "completed" } }),
  ];
  assert.deepEqual(storedGoal(events), { id: "g1", revision: 1, objective: "ship it", phase: "active", roundsStarted: 1, maxGoalRounds: 8 });
  events.push(change("pause", { ...goal, revision: 2, phase: "paused" }, 1, 200));
  assert.equal(storedGoal(events).phase, "paused");
});
