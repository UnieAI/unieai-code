// The contract test: everything this bridge sends, checked against the schema
// generated from the Rust types themselves.
//
// Two independent implementations of one protocol drift. The openspec design for
// this transport names that as its first risk and answers it with "a shared
// contract test suite run against both backends" — this is our half. It matters
// more here than in most protocols because the client DROPS what it cannot
// deserialize, silently (app-server-client/src/remote.rs: `Err(_) => None`), so
// a missing field is indistinguishable from an engine that did nothing.
//
// Regenerate the schemas with `just write-app-server-schema` after changing the
// Rust types; this test then fails until the JS side follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateAgainstSchema, loadSchema, SCHEMA_DIR } from "./schema-check.mjs";
import { createHandlers } from "./server.mjs";
import { startedItem, completedItem, userMessageItem, agentMessageItem, reasoningItem } from "./items.mjs";
import { createApprovalBridge } from "./approval.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const haveSchemas = existsSync(join(repoRoot, SCHEMA_DIR, "ServerNotification.json"));
const skip = haveSchemas ? false : `run \`just write-app-server-schema\` — no schemas at ${SCHEMA_DIR}`;

/** Validate one notification against the ServerNotification union. */
function checkNotification(method, params) {
  const res = validateAgainstSchema("ServerNotification", { method, params }, { repoRoot });
  assert.equal(res.ok, true, `${method}\n  ${res.problems.join("\n  ")}`);
}

/** Drive a whole turn and collect every notification it emits. */
async function runTurn({ engine, input = "do the thing" } = {}) {
  const emitted = [];
  const handlers = createHandlers({ createEngineFor: engine, codexHome: "/h", version: "0.1.0" });
  const ctx = { emit: (m, p) => emitted.push([m, p]), request: async () => ({ decision: "decline" }) };
  const { thread } = await handlers["thread/start"]({ cwd: "/repo" }, ctx);
  await handlers["turn/start"]({ threadId: thread.id, input }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  return { emitted, handlers, thread };
}

test("the schemas are checked in, so this test cannot pass by being skipped", () => {
  assert.equal(haveSchemas, true, skip || "");
});

test("every notification a normal turn emits validates", { skip }, async () => {
  const { emitted } = await runTurn({
    engine: ({ emit }) => ({
      send: async () => {
        emit("item/agentMessage/delta", { delta: "hello" });
        emit("item/reasoning/textDelta", { delta: "thinking" });
      },
    }),
  });
  assert.ok(emitted.length >= 5, `expected a full lifecycle, saw ${emitted.length}`);
  for (const [method, params] of emitted) checkNotification(method, params);
});

test("a failing turn's error notification validates", { skip }, async () => {
  const { emitted } = await runTurn({
    engine: () => ({ send: async () => { throw new Error("gateway down"); } }),
  });
  const error = emitted.find(([m]) => m === "error");
  assert.ok(error, "no error notification was sent");
  checkNotification(...error);
});

test("the tool item types validate, started and completed", { skip }, () => {
  const cases = [
    ["bash", { cmd: "pytest -q" }, { command: "pytest -q", exitCode: 1 }],
    ["read", { filePath: "a.py" }, { command: "cat a.py" }],
    ["edit", { filePath: "a.py" }, { path: "a.py", kind: "update", diff: "@@ -1 +1 @@" }],
    ["write", { filePath: "n.py" }, { path: "n.py", kind: "add", diff: "@@" }],
    // A tool with no mapping: it must still produce a REAL item type.
    ["some_future_tool", {}, {}],
  ];
  for (const [tool, args, extra] of cases) {
    const started = startedItem({ tool, args, cwd: "/repo" });
    checkNotification("item/started", { threadId: "t", turnId: "u", item: started, startedAtMs: 1 });
    const done = completedItem({ tool, id: started.id, output: "out", extra, cwd: "/repo" });
    checkNotification("item/completed", { threadId: "t", turnId: "u", item: done, completedAtMs: 2 });
  }
});

test("the message and reasoning items validate", { skip }, () => {
  for (const item of [userMessageItem("u1", "hi"), agentMessageItem("a1", "yo"), reasoningItem("r1", "because")]) {
    checkNotification("item/started", { threadId: "t", turnId: "u", item, startedAtMs: 1 });
  }
});

test("both approval requests validate against ServerRequest", { skip }, async () => {
  const sent = [];
  const ask = createApprovalBridge({
    request: async (method, params) => { sent.push({ method, params }); return { decision: "decline" }; },
    cwd: "/repo",
    ids: () => ({ threadId: "t", turnId: "u" }),
  });
  await ask({ tool: "bash", action: "run outside the sandbox", detail: "rm -rf build" });
  await ask({ tool: "fs", kind: "read_only_write", action: "write a.py", detail: "/repo/a.py" });

  assert.equal(sent.length, 2);
  for (const [i, { method, params }] of sent.entries()) {
    // ServerRequest is the JSON-RPC envelope, id included — the transport adds
    // the id when it sends (server.mjs allocates negative ids so the two
    // namespaces cannot collide), so the envelope is what has to validate.
    const res = validateAgainstSchema("ServerRequest", { id: -(i + 1), method, params }, { repoRoot });
    assert.equal(res.ok, true, `${method}\n  ${res.problems.join("\n  ")}`);
  }
});

test("the Thread a client receives validates", { skip }, async () => {
  const handlers = createHandlers({ createEngineFor: () => ({}), codexHome: "/h", version: "0.1.0" });
  const emitted = [];
  await handlers["thread/start"]({ cwd: "/repo" }, { emit: (m, p) => emitted.push([m, p]) });
  const started = emitted.find(([m]) => m === "thread/started");
  assert.ok(started, "thread/started was not emitted");
  checkNotification(...started);
});

// ── the checker itself ───────────────────────────────────────────────────────
// A validator that passes everything is worse than none: it converts a real
// contract into a green tick. These pin that it actually rejects.

test("the checker catches a missing required field", { skip }, () => {
  const res = validateAgainstSchema(
    "ServerNotification",
    { method: "error", params: { error: { message: "x" } } }, // no willRetry/threadId/turnId
    { repoRoot }
  );
  assert.equal(res.ok, false, "a notification missing three required fields was accepted");
});

test("the checker catches a wrong type and an unknown method", { skip }, () => {
  const wrongType = validateAgainstSchema(
    "ServerNotification",
    { method: "thread/status/changed", params: { threadId: 42, status: { type: "running" } } },
    { repoRoot }
  );
  assert.equal(wrongType.ok, false, "a numeric threadId was accepted");

  const unknown = validateAgainstSchema("ServerNotification", { method: "not/a/method", params: {} }, { repoRoot });
  assert.equal(unknown.ok, false, "an invented method was accepted");
});

test("a schema that is not on disk is a failure, not a silent pass", { skip }, () => {
  const res = validateAgainstSchema("NoSuchSchema", {}, { repoRoot });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
});

test("the union really does cover the methods we send", { skip }, () => {
  // Guards against the checker passing because it matched some permissive
  // branch: every method below must appear in the schema's own method enums.
  const schema = loadSchema("ServerNotification", { repoRoot });
  const methods = new Set(
    schema.oneOf.flatMap((b) => b.properties?.method?.enum ?? [])
  );
  for (const m of [
    "thread/started", "thread/status/changed", "turn/started", "turn/completed",
    "item/started", "item/completed", "item/agentMessage/delta", "item/reasoning/textDelta", "error",
  ]) {
    assert.ok(methods.has(m), `${m} is not a method this protocol defines`);
  }
});
