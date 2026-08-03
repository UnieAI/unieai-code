import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";

// UNIEAI_HOME before anything resolves it: the engine writes sessions, trees,
// snapshots and approvals under it, and the real ~/.unieai is user data.
const HOME = mkdtempSync(join(tmpdir(), "unieai-engine-tree-"));
process.env.UNIEAI_HOME = HOME;
// The engine defaults to the Responses wire; the stub below speaks the simpler
// chat-completions one, and applyUpstreamEnv honours an env that is already set.
process.env.AGENT_CORE_WIRE_API = "chat";

/**
 * A stub gateway, so a turn can run end to end without a model.
 *
 * Streaming requests (the loop's steps) get `reply`; non-streaming ones (the
 * between-turns summarizer) get `summary`. Nothing here has to be realistic
 * beyond the wire shape — what is under test is what the engine does with the
 * messages, not what the model says.
 */
const stub = { reply: "done.", summary: "## Objective\nthe folded turns, summarized" };
const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    stub.lastMessages = parsed.messages || [];
    if (!parsed.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: stub.summary } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stub.reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
gateway.unref();

writeFileSync(
  join(HOME, "unieai.json"),
  JSON.stringify({
    gateway_base_url: `http://127.0.0.1:${gateway.address().port}`,
    gateway_api_key: "test-key",
    studio_url: "http://127.0.0.1:9",
    available_model_ids: ["big-model", "small-model"],
  }),
  "utf8"
);

const { createEngine } = await import("./engine.mjs");
const { saveSession, loadSession } = await import("./session.mjs");
const { loadSessionTree } = await import("./session-tree-store.mjs");
const { deriveEngineContext, foldedEntries } = await import("./session-tree-context.mjs");
const { ENTRY_TYPES, deriveState, currentPath } = await import(
  "../../third_party/unieai-agent-core/src/session-tree.mjs"
);

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function workspace(name) {
  const dir = mkdtempSync(join(tmpdir(), `unieai-ws-${name}-`));
  return dir;
}

/** The shape session.mjs writes, matching the real files under agent-sessions/. */
const LEGACY = {
  id: "2026-07-22T04-06-38-legacy",
  model: "small-model",
  cwd: "/Users/dev/project",
  updatedAt: 1753000000000,
  summary: "",
  contextEpoch: { date: "Current date: 2026-07-22", "agents-md": "" },
  checkpoints: [{ messageIndex: 4, tree: "3b2e642462f6f50e0a51f6f5deb17d65af59d480" }],
  plan: null,
  messages: [
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_0", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
    { role: "tool", tool_call_id: "call_0", content: "README.md" },
    { role: "assistant", content: "one file: README.md" },
  ],
};

test("a new session starts as a tree whose derived prompt is the seeded one", () => {
  const engine = createEngine({ workspace: workspace("new"), model: "big-model" });

  const { messages } = deriveEngineContext(engine.sessionTree);
  assert.deepEqual(engine.messages, messages, "engine.messages is derived, not stored");
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /UnieAI Code/);
  // The model and cwd are recorded as state, so the tree alone can answer
  // "which model was answering" without a side file.
  assert.deepEqual(deriveState(currentPath(engine.sessionTree)), {
    model: "big-model",
    cwd: engine.sessionTree.entries.find((e) => e.type === ENTRY_TYPES.STATE_CHANGE).patch.cwd,
  });
});

test("a legacy session resumes with exactly the messages the array loader produced", () => {
  saveSession(LEGACY);
  const fromDisk = loadSession(LEGACY.id);

  const engine = createEngine({ workspace: workspace("legacy"), resume: LEGACY.id });
  assert.equal(engine.sessionId, LEGACY.id);
  assert.equal(engine.model, LEGACY.model, "the model comes back from the migrated state entry");

  const messages = engine.messages;
  assert.deepEqual(
    messages.slice(0, fromDisk.messages.length),
    fromDisk.messages,
    "not one message of a real session may change shape on resume"
  );
  // The only thing a resume may add is the context delta for what changed while
  // the session was away — which the array engine appended in the same place.
  for (const extra of messages.slice(fromDisk.messages.length)) {
    assert.equal(extra.role, "user");
    assert.match(extra.content, /^<context_update>/);
  }
});

test("a turn appends its messages to the tree, and the next turn does not repeat them", async () => {
  const engine = createEngine({ workspace: workspace("turns"), model: "big-model" });
  const seeded = engine.messages.length;

  stub.reply = "the first answer";
  await engine.send("the first question");
  assert.deepEqual(engine.messages.slice(seeded), [
    { role: "user", content: "the first question" },
    { role: "assistant", content: "the first answer" },
  ]);

  stub.reply = "the second answer";
  await engine.send("the second question");
  // The turn's boundary is what keeps a re-derived prompt from being folded back
  // into the tree a second time; getting it wrong duplicates the whole history.
  assert.equal(engine.messages.length, seeded + 4);
  assert.deepEqual(engine.messages.slice(seeded + 2), [
    { role: "user", content: "the second question" },
    { role: "assistant", content: "the second answer" },
  ]);
  assert.deepEqual(loadSession(engine.sessionId).messages, engine.messages);
  assert.deepEqual(deriveEngineContext(loadSessionTree(engine.sessionId).tree).messages, engine.messages);
});

test("a turn on a resumed legacy session continues it instead of restarting it", async () => {
  const id = "2026-07-22T04-06-40-resumed";
  saveSession({ ...LEGACY, id });

  const engine = createEngine({ workspace: workspace("resumed"), resume: id });
  const before = engine.messages.length;
  stub.reply = "still here";
  await engine.send("one more thing");

  assert.equal(engine.messages.length, before + 2);
  assert.deepEqual(engine.messages.slice(0, LEGACY.messages.length), LEGACY.messages);
  // The legacy file keeps being written, because the session picker and the VS
  // Code panel still read it directly.
  assert.deepEqual(loadSession(id).messages, engine.messages);
  const tree = loadSessionTree(id);
  assert.equal(tree.source, "tree");
  assert.deepEqual(deriveEngineContext(tree.tree).messages, engine.messages);
});

test("compaction lands as an entry and the folded turns are still in the file", async () => {
  const engine = createEngine({ workspace: workspace("fold"), model: "big-model" });
  stub.reply = "an answer with enough words in it to weigh something at all";
  await engine.send("a question with enough words in it to weigh something at all");
  const beforeFold = engine.messages.length;

  // Budgets low enough that the next turn is over them. Read at call time, so
  // setting them around one turn is enough.
  process.env.AGENT_1_0_CONTEXT_TOKENS = "200";
  process.env.AGENT_1_0_COMPACT_KEEP_TOKENS = "40";
  process.env.AGENT_1_0_COMPACT_BUFFER_TOKENS = "0";
  try {
    await engine.send("a second question, also long enough to matter for the budget");
  } finally {
    delete process.env.AGENT_1_0_CONTEXT_TOKENS;
    delete process.env.AGENT_1_0_COMPACT_KEEP_TOKENS;
    delete process.env.AGENT_1_0_COMPACT_BUFFER_TOKENS;
  }

  const compactions = engine.sessionTree.entries.filter((e) => e.type === ENTRY_TYPES.COMPACTION);
  assert.equal(compactions.length, 1, "the fold is one entry, not a rewritten history");
  assert.match(compactions[0].summary, /<conversation_summary>/);
  assert.equal(compactions[0].summaryText, stub.summary);

  const prompt = engine.messages;
  assert.ok(prompt.length < beforeFold + 2, "the prompt really did shrink");
  assert.equal(prompt[0].role, "system", "the system prompt survives the fold");
  assert.ok(prompt.some((m) => String(m.content).includes("<conversation_summary>")));

  // The point of the tree: the fold hid the first turn from the prompt, and the
  // file still holds every word of it.
  const stored = loadSessionTree(engine.sessionId).tree.entries
    .filter((e) => e.type === ENTRY_TYPES.MESSAGE)
    .map((e) => e.message.content);
  assert.ok(stored.includes("a question with enough words in it to weigh something at all"));
  assert.ok(!prompt.some((m) => m.content === "a question with enough words in it to weigh something at all"));
  assert.equal(foldedEntries(engine.sessionTree).length > 0, true);
});

test("resume carries the rolling summary, epoch, plan and checkpoints across", () => {
  const id = "2026-07-22T04-06-39-meta";
  saveSession({
    ...LEGACY,
    id,
    summary: "## Objective\nport the engine to the tree",
    plan: { steps: [{ text: "read the store", done: false }] },
    checkpoints: [{ messageIndex: 4, tree: "abc" }, { messageIndex: 2, tree: "def" }],
  });

  const engine = createEngine({ workspace: workspace("meta"), resume: id });
  const described = engine.describeCheckpoints();
  assert.equal(described.length, 2);
  // A legacy checkpoint only knew a message COUNT; it now names the entry that
  // produced that message, and the count is derived back from it.
  assert.equal(described[0].messageIndex, 4);
  assert.equal(described[0].entryId, "m3");
  assert.equal(described[1].messageIndex, 2);
  assert.equal(described[1].entryId, "m1");
});

test("resuming a session that does not exist fails instead of silently starting a new one", () => {
  assert.throws(() => createEngine({ workspace: workspace("missing"), resume: "no-such-session" }), /not found/);
});

test("a session persists to both stores, and the tree is what a resume reads", { skip: !gitAvailable }, async () => {
  const ws = workspace("persist");
  spawnSync("git", ["init", "-q"], { cwd: ws });
  writeFileSync(join(ws, "a.txt"), "before\n");

  const engine = createEngine({ workspace: ws, model: "big-model" });
  // The baseline checkpoint lands on the background snapshot chain.
  for (let i = 0; i < 200 && engine.checkpoints.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(engine.checkpoints.length, 1, "session start is itself a rewind point");
  assert.equal(engine.checkpoints[0].entryId, engine.sessionTree.leafId, "a checkpoint names an entry");

  // applyRewind is the one path that persists without a model call.
  writeFileSync(join(ws, "a.txt"), "after\n");
  const preview = await engine.previewRewind(0);
  assert.deepEqual(preview.files.map((f) => f.path), ["a.txt"]);
  const applied = await engine.applyRewind(0);
  assert.deepEqual(applied.restored, ["a.txt"]);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "before\n");
  assert.equal(engine.checkpoints.length, 2, "a rewind is itself rewindable");

  // Both stores were written, and they agree on the conversation.
  const tree = loadSessionTree(engine.sessionId);
  assert.equal(tree.source, "tree");
  assert.deepEqual(deriveEngineContext(tree.tree).messages, engine.messages);
  assert.deepEqual(loadSession(engine.sessionId).messages, engine.messages);

  // Resuming reads the tree back, entries and all.
  const resumed = createEngine({ workspace: ws, resume: engine.sessionId });
  assert.equal(resumed.sessionId, engine.sessionId);
  assert.deepEqual(resumed.messages.slice(0, engine.messages.length), engine.messages);
  assert.equal(resumed.checkpoints.length, 2);
  assert.equal(resumed.describeCheckpoints()[0].entryId, engine.checkpoints[0].entryId);
});
