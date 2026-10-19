// Copyright (c) 2026 UnieAI. All rights reserved.
// Thread-scoped methods the uac server answers itself because the Rust side
// does not know its threads: /model and /permissions, `!command`, and the
// background terminal list /cd checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHandlers } from "./server.mjs";
import { validateAgainstSchema, SCHEMA_DIR } from "./schema-check.mjs";
import { shellNote, withShellNotes, NOTE_OUTPUT_LIMIT } from "./unieai-shell-command.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const haveSchemas = existsSync(join(repoRoot, SCHEMA_DIR, "ServerNotification.json"));

/** Handlers over an engine that records what it was told. */
async function setup() {
  const configured = [];
  const sent = [];
  const emitted = [];
  let engineOptions = null;
  const handlers = createHandlers({
    codexHome: "/h",
    createEngineFor: (options) => {
      engineOptions = options;
      return {
        configure: async (settings) => configured.push(settings),
        send: async (text) => sent.push(text),
      };
    },
  });
  const ctx = { emit: (method, params) => emitted.push([method, params]), request: async () => ({}) };
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd(), model: "first" }, ctx);
  const live = handlers._threads.get(thread.id);
  return { handlers, ctx, thread, configured, sent, emitted, live, engineOptions: () => engineOptions };
}

test("/model and /permissions reach the engine and stay with the thread", async () => {
  const { handlers, ctx, thread, configured, live } = await setup();
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "hi" }] }, ctx);
  await handlers["thread/settings/update"]({
    threadId: thread.id,
    model: "second",
    effort: "high",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly" },
  });
  assert.deepEqual(configured, [{ model: "second", effort: "high", permissions: true }]);
  assert.deepEqual([live.model, live.effort, live.permissions], ["second", "high", { sandbox: "read-only", approval: "never", reviewer: null }]);

  // turn/start carries the same settings every time: unchanged, nothing to do.
  await handlers["turn/start"]({ threadId: thread.id, model: "second", approvalPolicy: "never", input: [{ type: "text", text: "again" }] }, ctx);
  assert.equal(configured.length, 1);
});

test("\"Approve for me\" (approvalsReviewer auto_review) is auto mode, and is reported back", async () => {
  const { handlers, ctx, thread, configured, live, emitted } = await setup();
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "hi" }] }, ctx);
  await handlers["thread/settings/update"]({ threadId: thread.id, approvalPolicy: "on-request", approvalsReviewer: "auto_review" }, ctx);
  assert.deepEqual(live.permissions, { sandbox: null, approval: "ask", reviewer: "auto" });
  assert.deepEqual(configured.at(-1), { model: null, effort: null, permissions: true });
  const [method, params] = emitted.findLast(([m]) => m === "thread/settings/updated");
  assert.equal(params.threadSettings.approvalsReviewer, "auto_review");
  if (haveSchemas) {
    const result = validateAgainstSchema("ServerNotification", { method, params }, { repoRoot });
    assert.equal(result.ok, true, `${method}\n  ${result.problems.join("\n  ")}`);
  }

  // Back to "Ask for approval": the TUI sends the reviewer as user.
  await handlers["thread/settings/update"]({ threadId: thread.id, approvalPolicy: "on-request", approvalsReviewer: "user" }, ctx);
  assert.equal(live.permissions.reviewer, "user");
  assert.equal(emitted.findLast(([m]) => m === "thread/settings/updated")[1].threadSettings.approvalsReviewer, "user");

  // A thread started in auto mode says so, and its engine is told.
  const started = await handlers["thread/start"]({ cwd: process.cwd(), approvalPolicy: "on-request", approvalsReviewer: "auto_review" }, ctx);
  assert.equal(started.approvalsReviewer, "auto_review");
  assert.deepEqual(handlers._threads.get(started.thread.id).permissions, { sandbox: null, approval: "ask", reviewer: "auto" });
  // Not chosen: the user answers, as before.
  const plain = await handlers["thread/start"]({ cwd: process.cwd(), approvalPolicy: "on-request" }, ctx);
  assert.equal(plain.approvalsReviewer, "user");
});

test("a settings update says what is now in force, so the client stops waiting on it", async () => {
  const { handlers, ctx, thread, emitted } = await setup();
  await handlers["thread/settings/update"]({ threadId: thread.id, permissions: "my-profile", approvalPolicy: "never" }, ctx);
  const [method, params] = emitted.findLast(([m]) => m === "thread/settings/updated");
  assert.equal(params.threadId, thread.id);
  assert.deepEqual(
    [params.threadSettings.activePermissionProfile, params.threadSettings.approvalPolicy],
    [{ id: "my-profile", extends: null }, "never"],
  );
  if (haveSchemas) {
    const result = validateAgainstSchema("ServerNotification", { method, params }, { repoRoot });
    assert.equal(result.ok, true, `${method}\n  ${result.problems.join("\n  ")}`);
  }

  // Nothing moved, but the client is still owed an answer: without one its
  // pending change never clears and it refuses to switch task or fork.
  emitted.length = 0;
  await handlers["thread/settings/update"]({ threadId: thread.id, permissions: "my-profile" }, ctx);
  assert.equal(emitted.filter(([m]) => m === "thread/settings/updated").length, 1);
});

test("`!command` runs in the thread's directory, shows as a user shell card, and reaches the model once", async () => {
  const { handlers, ctx, thread, sent, emitted } = await setup();
  assert.deepEqual(await handlers["thread/shellCommand"]({ threadId: thread.id, command: "echo shell-$((20+22))" }, ctx), {});
  for (let i = 0; i < 100 && !emitted.some(([method]) => method === "turn/completed"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const card = emitted.find(([method, params]) => method === "item/completed" && params.item.type === "commandExecution")[1].item;
  assert.deepEqual([card.command, card.source, card.status, card.exitCode, card.aggregatedOutput], ["echo shell-$((20+22))", "userShell", "completed", 0, "shell-42\n"]);
  if (haveSchemas) {
    for (const [method, params] of emitted) {
      const result = validateAgainstSchema("ServerNotification", { method, params }, { repoRoot });
      assert.equal(result.ok, true, `${method}\n  ${result.problems.join("\n  ")}`);
    }
  }

  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "what did it print?" }] }, ctx);
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "and now?" }] }, ctx).catch(() => {});
  assert.match(sent[0], /<command>echo shell-\$\(\(20\+22\)\)<\/command>\n<exit_code>0<\/exit_code>\n<output>\nshell-42\n/);
  assert.match(sent[0], /what did it print\?$/);
});

test("a long output is cut in the middle before the model sees it", () => {
  const note = shellNote("yes", { output: "a".repeat(NOTE_OUTPUT_LIMIT * 3), exitCode: 0 });
  assert.ok(note.length < NOTE_OUTPUT_LIMIT + 300);
  assert.match(note, /\[\.\.\. 8000 characters omitted \.\.\.\]/);
  assert.equal(withShellNotes([], "hi"), "hi");
});

test("no background terminals to list or clean, so /cd is not blocked", async () => {
  const { handlers, thread } = await setup();
  assert.deepEqual(await handlers["thread/backgroundTerminals/list"]({ threadId: thread.id }), { data: [], nextCursor: null });
  assert.deepEqual(await handlers["thread/backgroundTerminals/clean"]({ threadId: thread.id }), {});
});

test("a compaction dsh decides on itself is shown like one the user asked for", async () => {
  const { handlers, ctx, thread, emitted, live, engineOptions: engineOptionsOf } = await setup();
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "work" }] }, ctx);
  const engineOptions = engineOptionsOf();
  engineOptions.onCompaction({ phase: "start", requested: false });
  engineOptions.onCompaction({ phase: "end", requested: false });
  const compaction = emitted
    .filter(([, params]) => params.item?.type === "contextCompaction")
    .map(([method, params]) => [method, params.item.id]);
  assert.equal(compaction.length, 2, `expected a start and an end, saw ${JSON.stringify(compaction)}`);
  assert.deepEqual(
    compaction.map(([method]) => method),
    ["item/started", "item/completed"],
  );
  assert.equal(compaction[0][1], compaction[1][1], "the same item, so the client can close its timer");

  // /compact already shows a turn of its own: dsh's events for it add nothing.
  emitted.length = 0;
  thread.compacting = true;
  live.compacting = true;
  engineOptions.onCompaction({ phase: "start", requested: false });
  engineOptions.onCompaction({ phase: "end", requested: false });
  live.compacting = false;
  engineOptions.onCompaction({ phase: "start", requested: true });
  assert.deepEqual(emitted.filter(([, params]) => params.item?.type === "contextCompaction"), []);
});

test("the plan and a question end the message the model was streaming", async () => {
  const emitted = [];
  let engineOptions = null;
  let finish = null;
  const handlers = createHandlers({
    codexHome: "/h",
    // The turn is still running: that is when the client holds the message.
    createEngineFor: (options) => {
      engineOptions = options;
      return { send: () => new Promise((resolve) => (finish = resolve)) };
    },
  });
  const ctx = { emit: (method, params) => emitted.push([method, params]), request: async () => ({}) };
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, ctx);
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "plan it" }] }, ctx);
  const engine = engineOptions;
  engine.emit("item/agentMessage/delta", { delta: "I'll set up the list" });
  engine.emit("turn/plan/updated", { plan: [{ step: "read", status: "pending" }] });
  const order = emitted
    .map(([method, params]) => (params?.item?.type === "agentMessage" ? `${method}:agentMessage` : method))
    .filter((method) => method.endsWith("agentMessage") || method === "turn/plan/updated");
  assert.deepEqual(
    order.slice(-2),
    ["item/completed:agentMessage", "turn/plan/updated"],
    "the message is closed before the plan, so a client holding it does not wait forever",
  );
  finish();
});

test("an interrupt ends the turn even when the engine will not stop", async () => {
  const emitted = [];
  const handlers = createHandlers({
    codexHome: "/h",
    // dsh that ignores the abort: its promise never settles, so nothing but
    // the interrupt itself can close the turn.
    createEngineFor: () => ({ send: () => new Promise(() => {}), cancel: () => {} }),
    interruptGraceMs: 40,
  });
  const ctx = { emit: (method, params) => emitted.push([method, params]), request: async () => ({}) };
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, ctx);
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "go" }] }, ctx);
  await handlers["turn/interrupt"]({ threadId: thread.id });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const completed = emitted.findLast(([method]) => method === "turn/completed");
  assert.equal(completed?.[1].turn.status, "interrupted");
  if (haveSchemas) {
    const result = validateAgainstSchema("ServerNotification", { method: completed[0], params: completed[1] }, { repoRoot });
    assert.equal(result.ok, true, result.problems.join("\n  "));
  }

  // The whole point: the next message is accepted instead of being refused
  // with "cannot start a turn while a turn is running" for good.
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "again" }] }, ctx);
});

test("unieai/context/read asks the thread's engine, and says so when it cannot", async () => {
  const usage = { totalTokens: 1200, categories: [] };
  const handlers = createHandlers({ codexHome: "/h", createEngineFor: () => ({ context: async () => usage }) });
  const ctx = { emit: () => {}, request: async () => ({}) };
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, ctx);
  assert.deepEqual(await handlers["unieai/context/read"]({ threadId: thread.id }, ctx), usage);

  const plain = createHandlers({ codexHome: "/h", createEngineFor: () => ({}) });
  const other = (await plain["thread/start"]({ cwd: process.cwd() }, ctx)).thread;
  await assert.rejects(() => plain["unieai/context/read"]({ threadId: other.id }, ctx), /not supported by this engine/);
});

test("another client reading a thread does not take over its tool calls and approvals", async () => {
  // One uac server serves every TUI on the machine. Session A's model reads
  // session B's thread (wait_threads / read_thread) while B's TUI drives it;
  // B's client tool calls (send_peer_message) and approvals must still reach B.
  const asked = { a: [], b: [] };
  let engineOptions = null;
  const handlers = createHandlers({
    codexHome: "/h",
    createEngineFor: (options) => {
      engineOptions = options;
      return {
        configure: async () => {},
        send: async () => {},
        history: async () => [],
        goal: async () => null,
        fork: async () => ({ sessionId: "forked" }),
      };
    },
  });
  const client = (name) => ({ emit: () => {}, request: async (method) => (asked[name].push(method), {}) });
  const ctxA = client("a");
  const ctxB = client("b");
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd(), model: "m" }, ctxB);
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "hi" }] }, ctxB);

  await handlers["thread/read"]({ threadId: thread.id, includeTurns: true }, ctxA);
  await handlers["thread/turns/list"]({ threadId: thread.id, limit: 1, sortDirection: "desc" }, ctxA);
  await handlers["thread/items/list"]({ threadId: thread.id }, ctxA);
  await handlers["thread/goal/get"]({ threadId: thread.id }, ctxA);

  await engineOptions.request("item/tool/call", { threadId: thread.id, tool: "send_peer_message" });
  assert.deepEqual(asked, { a: [], b: ["item/tool/call"] });
  assert.equal(handlers._threads.get(thread.id).connection, ctxB);
});
