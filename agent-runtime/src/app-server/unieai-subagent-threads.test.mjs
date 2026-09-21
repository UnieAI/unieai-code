// Copyright (c) 2026 UnieAI. All rights reserved.
// dsh subagents shown as codex agent threads: the parent's rows, the child's
// own thread, and every notification valid for the client (it drops what it
// cannot deserialize, silently).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateAgainstSchema, SCHEMA_DIR } from "./schema-check.mjs";
import { createHandlers } from "./server.mjs";
import { pathSegment } from "./unieai-subagent-threads.mjs";
import { userMessageItem, agentMessageItem, completedItem } from "./items.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skip = existsSync(join(repoRoot, SCHEMA_DIR, "ServerNotification.json")) ? false : "no generated schemas";
const CHILD = "55473fec-fb8b-424a-a5ba-7e6478803548";
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A thread whose engine is running a turn, with the engine's subagent hooks captured. */
async function parentWithTurn(history) {
  const emitted = [];
  let hooks = null;
  let finishTurn = null;
  const handlers = createHandlers({
    codexHome: "/h",
    createEngineFor: (options) => {
      hooks = options;
      return {
        send: () => new Promise((resolve) => (finishTurn = resolve)),
        subagentHistory: async (id) => (id === CHILD ? history() : []),
      };
    },
  });
  const ctx = { emit: (method, params) => emitted.push([method, params]), request: async () => ({}) };
  const { thread } = await handlers["thread/start"]({ cwd: "/repo" }, ctx);
  await handlers["turn/start"]({ threadId: thread.id, input: "delegate it" }, ctx);
  return { emitted, handlers, thread, hooks, finishTurn: () => finishTurn() };
}

test("a label becomes one agent-path segment", () => {
  assert.equal(pathSegment("Count lines in calc.py", "x"), "count_lines_in_calc_py");
  assert.equal(pathSegment("  ", "agent_55473fec"), "agent_55473fec");
  assert.equal(pathSegment(null, "agent_1"), "agent_1");
});

test("a subagent is a row in its parent and a live thread of its own", { skip }, async () => {
  let childTurns = [];
  const { emitted, handlers, thread, hooks, finishTurn } = await parentWithTurn(() => childTurns);
  const parentSession = "parent-session";
  const base = { sessionId: CHILD, parentSessionId: parentSession };

  hooks.onSubagent({ ...base, phase: "start", label: "Count lines in calc.py", depth: 1, cwd: "/repo", model: "m" });
  childTurns = [
    { status: "inProgress", items: [userMessageItem("", "count the lines"), { ...completedItem({ tool: "bash", id: "", ok: true, output: "", extra: { args: { cmd: "wc -l calc.py" } } }), status: "inProgress" }] },
  ];
  hooks.onChildActivity({ ...base, type: "tool/call" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  childTurns = [
    {
      status: "completed",
      items: [
        userMessageItem("", "count the lines"),
        completedItem({ tool: "bash", id: "", ok: true, output: "10 calc.py", extra: { args: { cmd: "wc -l calc.py" } } }),
        agentMessageItem("", "10 lines"),
      ],
    },
  ];
  hooks.onSubagent({ ...base, phase: "end", stopReason: "completed", lastAssistantMessage: "10 lines" });
  await settle();

  for (const [method, params] of emitted) {
    const result = validateAgainstSchema("ServerNotification", { method, params }, { repoRoot });
    assert.equal(result.ok, true, `${method}\n  ${result.problems.join("\n  ")}`);
  }

  const rows = emitted
    .filter(([method, params]) => method === "item/completed" && params.item.type === "subAgentActivity")
    .map(([, params]) => [params.threadId, params.item.kind, params.item.agentThreadId, params.item.agentPath]);
  assert.deepEqual(rows, [
    [thread.id, "started", CHILD, "/root/count_lines_in_calc_py"],
    [thread.id, "completed", CHILD, "/root/count_lines_in_calc_py"],
  ]);

  const started = emitted.find(([method, params]) => method === "thread/started" && params.thread.id === CHILD)[1].thread;
  assert.deepEqual(
    [started.id, started.parentThreadId, started.agentNickname, started.canAcceptDirectInput, started.source],
    [
      CHILD,
      thread.id,
      "Count lines in calc.py",
      false,
      { subagent: { thread_spawn: { parent_thread_id: thread.id, depth: 1, agent_path: "/root/count_lines_in_calc_py", agent_nickname: "Count lines in calc.py", agent_role: null } } },
    ],
  );

  // The child's thread, live: its turn opens, the command runs then
  // completes, the answer arrives, the turn ends.
  const childEvents = emitted
    .filter(([, params]) => params.threadId === CHILD)
    .map(([method, params]) => (params.item ? `${method}:${params.item.type}` : method));
  assert.deepEqual(childEvents, [
    "thread/status/changed",
    "turn/started",
    "item/completed:userMessage",
    "item/started:commandExecution",
    "item/completed:commandExecution",
    "item/completed:agentMessage",
    "turn/completed",
    "thread/status/changed",
    // It has finished, so it stops being one of "who is working": without
    // this the client keeps its row for the rest of the session.
    "thread/closed",
  ]);

  // Opening it from the agent picker reads the same turns.
  const read = await handlers["thread/read"]({ threadId: CHILD, includeTurns: true });
  assert.deepEqual(read.thread.turns.map((turn) => [turn.status, turn.items.map((item) => item.type)]), [
    ["completed", ["userMessage", "commandExecution", "agentMessage"]],
  ]);
  const resumed = await handlers["thread/resume"]({ threadId: CHILD });
  assert.equal(resumed.thread.id, CHILD);
  await assert.rejects(handlers["turn/start"]({ threadId: CHILD, input: "hi" }), /subagent's thread/);
  finishTurn();
});

test("a row that arrives while a card runs waits for that card", async () => {
  const { emitted, hooks, finishTurn } = await parentWithTurn(() => []);
  const base = { sessionId: CHILD, parentSessionId: "parent-session" };
  hooks.onSubagent({ ...base, phase: "start", label: "count" });
  const card = completedItem({ tool: "wait_agents", id: "wait-1", ok: true, output: "", extra: { args: {} } });
  hooks.emit("item/started", { item: { ...card, status: "inProgress" }, startedAtMs: 1 });
  hooks.onSubagent({ ...base, phase: "end", stopReason: "completed" });
  await settle();
  hooks.emit("item/completed", { item: card, completedAtMs: 2 });
  const order = emitted
    .filter(([method, params]) => method === "item/completed" && (params.item.type === "subAgentActivity" || params.item.id === "wait-1"))
    .map(([, params]) => (params.item.type === "subAgentActivity" ? params.item.kind : params.item.id));
  assert.deepEqual(order, ["started", "wait-1", "completed"]);
  finishTurn();
});
