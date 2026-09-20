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
  assert.deepEqual([live.model, live.effort, live.permissions], ["second", "high", { sandbox: "read-only", approval: "never" }]);

  // turn/start carries the same settings every time: unchanged, nothing to do.
  await handlers["turn/start"]({ threadId: thread.id, model: "second", approvalPolicy: "never", input: [{ type: "text", text: "again" }] }, ctx);
  assert.equal(configured.length, 1);
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
