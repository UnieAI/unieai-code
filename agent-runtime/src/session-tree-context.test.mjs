import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Small budgets so a fold is reachable with a handful of short messages instead
// of 28k tokens of filler. Read by compaction.mjs at CALL time, and node's test
// runner gives each file its own process, so this cannot leak into other tests.
process.env.AGENT_1_0_COMPACT_KEEP_TOKENS = "40";
process.env.AGENT_1_0_COMPACT_BUFFER_TOKENS = "0";

// UNIEAI_HOME before anything that resolves it, so no test can reach the real one.
process.env.UNIEAI_HOME = mkdtempSync(join(tmpdir(), "unieai-tree-ctx-"));

const {
  appendFold,
  appendMessages,
  deriveEngineContext,
  foldedEntries,
  makeEntryIdFactory,
  messageIndexFor,
  messageOfEntry,
} = await import("./session-tree-context.mjs");
const { compactWithSummary } = await import("../../third_party/unieai-agent-core/src/compaction.mjs");
const {
  ENTRY_TYPES,
  createTree,
  deriveContext,
} = await import("../../third_party/unieai-agent-core/src/session-tree.mjs");
const { loadSessionTree, saveSessionTree, treeFromLegacy } = await import("./session-tree-store.mjs");

const CONTEXT_TOKENS = 60; // above the messages below, so only a long history folds

/** A session the way the engine seeds one: system prompt, project rules, turns. */
function sessionOf(turns) {
  const messages = [
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "<project_instructions>\nrepo rules\n</project_instructions>" },
  ];
  for (let i = 1; i <= turns; i += 1) {
    messages.push({ role: "user", content: `question ${i} about the parser and its many edge cases` });
    messages.push({ role: "assistant", content: `answer ${i} with plenty of words to make this heavy` });
  }
  let tree = createTree({ now: 1 });
  const nextId = makeEntryIdFactory(tree);
  const appended = appendMessages(tree, messages, { nextId, now: 1 });
  return { tree: appended.tree, ids: appended.ids, nextId, messages };
}

/** Fold a tree the way the engine does after a turn, with a stub summarizer. */
async function fold(tree, ids, nextId, { prevSummary = "", summary = "## Objective\nfix the parser", contextTokens = CONTEXT_TOKENS } = {}) {
  const messages = deriveEngineContext(tree).messages;
  const folded = await compactWithSummary({
    messages,
    prevSummary,
    ctx: { contextTokens },
    summarize: async () => summary,
  });
  const applied = appendFold(tree, { folded, entryIds: ids, nextId, now: 2 });
  return { folded, ...applied };
}

test("a session derives the messages it was built from, one entry per message", () => {
  const { tree, ids, messages } = sessionOf(2);
  const derived = deriveEngineContext(tree);
  assert.deepEqual(derived.messages, messages);
  assert.deepEqual(derived.entryIds, ids, "entryIds must stay parallel to messages");
});

test("an entry that carries no message contributes nothing to the prompt", () => {
  assert.equal(messageOfEntry({ type: ENTRY_TYPES.STATE_CHANGE, patch: { model: "m" } }), null);
  assert.equal(messageOfEntry({ type: ENTRY_TYPES.LABEL, text: "x" }), null);
  assert.deepEqual(messageOfEntry({ type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "hi" } }), {
    role: "user",
    content: "hi",
  });
});

test("compaction becomes an entry whose prompt matches what the array path produced", async () => {
  const { tree, ids, nextId } = sessionOf(6);
  const { folded, tree: compacted, applied, entryId } = await fold(tree, ids, nextId);

  assert.equal(folded.changed, true, "the fixture must actually be over budget");
  assert.equal(applied, true);
  const entry = compacted.byId.get(entryId);
  assert.equal(entry.type, ENTRY_TYPES.COMPACTION);
  assert.equal(entry.summaryText, folded.summary, "the raw summary is what the next fold merges");
  // The prompt is the point: entry or array, the model must see the same thing.
  assert.deepEqual(deriveEngineContext(compacted).messages, folded.messages);
});

test("the folded originals stay on the path, reachable but out of the prompt", async () => {
  const { tree, ids, nextId, messages } = sessionOf(6);
  const { tree: compacted } = await fold(tree, ids, nextId);

  const dropped = foldedEntries(compacted);
  assert.ok(dropped.length > 0);
  const prompt = deriveEngineContext(compacted).messages;
  assert.ok(prompt.length < messages.length, "the prompt really did shrink");
  // Every original is still in the tree, whether or not the prompt carries it.
  const stored = compacted.entries.filter((e) => e.type === ENTRY_TYPES.MESSAGE).map((e) => e.message);
  assert.deepEqual(stored, messages, "compaction must not delete a single message");
  assert.deepEqual(
    dropped.map((e) => e.message?.content),
    messages.slice(1, 1 + dropped.length).map((m) => m.content),
    "what was dropped is the head, and it is still readable"
  );
});

test("the system prompt survives a fold, which the core rule alone would drop", async () => {
  const { tree, ids, nextId } = sessionOf(6);
  const { tree: compacted } = await fold(tree, ids, nextId);

  assert.equal(deriveEngineContext(compacted).messages[0].role, "system");
  // The core applies the rule literally — this is the difference this module exists for.
  assert.notEqual(deriveContext(compacted).messages[0].role, "system");
});

test("a second fold folds the first, and the prompt still matches the array path", async () => {
  const { tree, ids, nextId } = sessionOf(6);
  const first = await fold(tree, ids, nextId);

  // The next turn's messages, with ids re-derived exactly as the engine does.
  const live = deriveEngineContext(first.tree);
  const grown = appendMessages(first.tree, [
    { role: "user", content: "question 7 about the parser and its many edge cases" },
    { role: "assistant", content: "answer 7 with plenty of words to make this heavy" },
  ], { nextId, now: 3 });
  const ids2 = [...live.entryIds, ...grown.ids];

  const second = await fold(grown.tree, ids2, nextId, { prevSummary: first.folded.summary, summary: "## Objective\nround two" });
  assert.equal(second.applied, true);
  assert.deepEqual(deriveEngineContext(second.tree).messages, second.folded.messages);
  assert.equal(
    second.tree.entries.filter((e) => e.type === ENTRY_TYPES.COMPACTION).length,
    2,
    "a fold is a new entry, never an edit of the previous one"
  );
});

test("a fold that changed nothing leaves the tree exactly as it was", async () => {
  const { tree, ids, nextId } = sessionOf(1);
  const { folded, applied, tree: after } = await fold(tree, ids, nextId, { contextTokens: 100_000 });
  assert.equal(folded.changed, false, "a session under budget is not folded at all");
  assert.equal(applied, false);
  assert.equal(after, tree);
});

test("a fold whose shape we cannot read is refused rather than guessed at", () => {
  const { tree, nextId } = sessionOf(1);
  // changed, but no summary message where the geometry says it should be: keeping
  // the history whole is the fail-open answer, since the mechanical per-request
  // path still bounds the prompt.
  const bad = appendFold(tree, { folded: { changed: true, messages: [], systemCount: 1, foldedCount: 2 }, nextId });
  assert.equal(bad.applied, false);
  assert.equal(bad.tree, tree);
});

test("a checkpoint's message index is derived from its entry, before and after a fold", async () => {
  const { tree, ids, nextId } = sessionOf(6);
  const last = ids[ids.length - 1];
  const early = ids[3];
  assert.equal(messageIndexFor(tree, last), ids.length, "the leaf sits at the end of the prompt");
  assert.equal(messageIndexFor(tree, early), 4);

  const { tree: compacted } = await fold(tree, ids, nextId);
  const prompt = deriveEngineContext(compacted).messages;
  // Still in the prompt → its real position; folded away → just after the summary,
  // which is where the array engine clamped a checkpoint inside a folded span.
  assert.equal(messageIndexFor(compacted, last), prompt.length);
  assert.equal(messageIndexFor(compacted, early), 2);
  assert.equal(messageIndexFor(compacted, "not-an-entry", { fallback: 7 }), 7, "an unknown entry is not invented");
  assert.equal(messageIndexFor(compacted, null, { fallback: 3 }), 3);
});

test("entry ids never collide with the ones a migrated legacy session brought", () => {
  const { tree } = treeFromLegacy({
    id: "s1",
    model: "m",
    cwd: "/w",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
  });
  const nextId = makeEntryIdFactory(tree);
  const grown = appendMessages(tree, [{ role: "assistant", content: "hello" }], { nextId });
  assert.equal(new Set(grown.tree.entries.map((e) => e.id)).size, grown.tree.entries.length);
  assert.deepEqual(deriveEngineContext(grown.tree).messages.map((m) => m.content), ["sys", "hi", "hello"]);
});

test("a folded session round-trips through the store with its prompt intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unieai-trees-"));
  const { tree, ids, nextId } = sessionOf(6);
  const { tree: compacted, folded } = await fold(tree, ids, nextId);
  saveSessionTree({ id: "s1", tree: compacted, meta: { summary: folded.summary }, dir });

  const loaded = loadSessionTree("s1", { dir });
  assert.deepEqual(deriveEngineContext(loaded.tree).messages, folded.messages);
  assert.equal(foldedEntries(loaded.tree).length, foldedEntries(compacted).length, "the originals survive the file");
  assert.equal(loaded.meta.summary, folded.summary);
});
