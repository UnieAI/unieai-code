import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point UNIEAI_HOME at a temp dir BEFORE importing anything that resolves it,
// so no test can reach the real ~/.unieai/agent-sessions.
const HOME = mkdtempSync(join(tmpdir(), "unieai-tree-store-"));
process.env.UNIEAI_HOME = HOME;

const {
  SESSION_TREE_FORMAT,
  SESSION_TREE_VERSION,
  detectShape,
  deserializeTree,
  legacySessionsDir,
  loadSessionTree,
  saveSessionTree,
  serializeTree,
  treeFromLegacy,
} = await import("./session-tree-store.mjs");
const { saveSession, loadSession } = await import("./session.mjs");
const {
  ENTRY_TYPES,
  append,
  branchPoints,
  createTree,
  currentPath,
  deriveContext,
  deriveState,
} = await import("../../third_party/unieai-agent-core/src/session-tree.mjs");

const msg = (role, content) => ({ type: ENTRY_TYPES.MESSAGE, message: { role, content } });

function tmpDirs() {
  return {
    dir: mkdtempSync(join(tmpdir(), "unieai-trees-")),
    legacyDir: mkdtempSync(join(tmpdir(), "unieai-legacy-")),
  };
}

/** The shape session.mjs actually writes, tool calls and all (see real files). */
const LEGACY = {
  id: "2026-07-22T04-06-38-wfq55p",
  model: "Qwen3.6",
  cwd: "/Users/dev/project",
  updatedAt: 1753000000000,
  summary: "",
  contextEpoch: { date: "Current date: 2026-07-22", "agents-md": "# AGENTS" },
  checkpoints: [{ index: 2, sha: "abc123" }],
  plan: null,
  messages: [
    { role: "system", content: "you are a coding agent" },
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_0", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }],
    },
    { role: "tool", tool_call_id: "call_0", content: "README.md" },
    { role: "assistant", content: "one file: README.md" },
  ],
};

function line(n) {
  let tree = createTree({ now: 5 });
  for (let i = 1; i <= n; i += 1) {
    tree = append(tree, msg("user", `q${i}`), { id: `u${i}`, now: 5 });
    tree = append(tree, msg("assistant", `a${i}`), { id: `a${i}`, now: 5 });
  }
  return tree;
}

test("a saved tree loads back with byId restored as a Map, not an empty object", () => {
  const { dir } = tmpDirs();
  saveSessionTree({ id: "s1", tree: line(2), dir });

  const loaded = loadSessionTree("s1", { dir });
  assert.ok(loaded.tree.byId instanceof Map, "byId must come back as a Map");
  assert.equal(loaded.tree.byId.size, 4);
  assert.equal(loaded.tree.byId.get("u2").message.content, "q2");
  assert.equal(loaded.tree.leafId, "a2");
  assert.deepEqual(currentPath(loaded.tree).map((e) => e.id), ["u1", "a1", "u2", "a2"]);
});

test("byId is absent from the file and rebuilt from entries, so the two cannot drift", () => {
  const { dir } = tmpDirs();
  const path = saveSessionTree({ id: "s1", tree: line(1), dir });

  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal("byId" in raw, false, "serializing a Map would have written {} and lost every entry");
  assert.deepEqual(raw.entries.map((e) => e.id), ["u1", "a1"]);
  // The reload derives a context, which is only possible if byId was rebuilt.
  assert.deepEqual(deriveContext(loadSessionTree("s1", { dir }).tree).messages.map((m) => m.content), ["q1", "a1"]);
});

test("a branch survives the round trip and is still recognisable as a fork", () => {
  const { dir } = tmpDirs();
  let tree = line(1);
  tree = append(tree, msg("user", "path A"), { id: "A", parentId: "a1" });
  tree = append(tree, msg("user", "path B"), { id: "B", parentId: "a1" });
  saveSessionTree({ id: "s1", tree, dir });

  const loaded = loadSessionTree("s1", { dir }).tree;
  assert.deepEqual(branchPoints(loaded), ["a1"]);
  assert.deepEqual(deriveContext(loaded, { entryId: "B" }).messages.map((m) => m.content), ["q1", "a1", "path B"]);
});

test("a migrated legacy session yields exactly the messages the legacy loader returns", () => {
  // Round-trip through the REAL writer and reader, so this compares against
  // production behaviour rather than against a hand-built expectation.
  saveSession(LEGACY);
  const viaLegacy = loadSession(LEGACY.id);
  const viaTree = loadSessionTree(LEGACY.id, { dir: mkdtempSync(join(tmpdir(), "unieai-trees-")) });

  assert.equal(viaTree.source, "legacy");
  assert.equal(viaTree.migrated, true);
  assert.deepEqual(deriveContext(viaTree.tree).messages, viaLegacy.messages);
  assert.equal(viaTree.path, join(legacySessionsDir(), `${LEGACY.id}.json`));
});

test("a legacy session becomes a straight line of message entries", () => {
  const { tree } = treeFromLegacy(LEGACY);
  const path = currentPath(tree);
  assert.equal(path.length, LEGACY.messages.length + 1, "one state_change plus one entry per message");
  assert.equal(path[0].type, ENTRY_TYPES.STATE_CHANGE);
  assert.deepEqual(path.slice(1).map((e) => e.type), LEGACY.messages.map(() => ENTRY_TYPES.MESSAGE));
  assert.deepEqual(branchPoints(tree), [], "a legacy session has no forks");
});

test("the model and cwd of a legacy session are recoverable as derived state", () => {
  const { tree } = treeFromLegacy(LEGACY);
  assert.deepEqual(deriveState(currentPath(tree)), { model: "Qwen3.6", cwd: "/Users/dev/project" });
});

test("migration keeps every legacy field it does not model, including unknown ones", () => {
  const { meta } = treeFromLegacy({ ...LEGACY, someFutureField: { keep: "me" } });
  assert.deepEqual(meta.contextEpoch, LEGACY.contextEpoch);
  assert.deepEqual(meta.checkpoints, LEGACY.checkpoints);
  assert.equal(meta.summary, "");
  assert.equal(meta.plan, null);
  assert.deepEqual(meta.someFutureField, { keep: "me" });
});

test("the rolling summary stays a plain field and never becomes a compaction entry", () => {
  // A compaction entry would drop everything before it from the derived prompt,
  // silently shortening a resumed conversation whose summary is already folded
  // into its messages.
  const { tree, meta } = treeFromLegacy({ ...LEGACY, summary: "earlier: the user asked for a listing" });
  assert.equal(meta.summary, "earlier: the user asked for a listing");
  assert.equal(tree.entries.some((e) => e.type === ENTRY_TYPES.COMPACTION), false);
  assert.equal(deriveContext(tree).messages.length, LEGACY.messages.length);
});

test("migrating the same legacy session twice produces an identical tree", () => {
  const a = treeFromLegacy(LEGACY);
  const b = treeFromLegacy(LEGACY);
  assert.deepEqual(a.tree.entries, b.tree.entries, "ids must be deterministic or a double migration forks the session");
  assert.equal(a.tree.leafId, b.tree.leafId);
});

test("loading a legacy session leaves the legacy file byte-for-byte unchanged", () => {
  const { dir, legacyDir } = tmpDirs();
  const legacyFile = join(legacyDir, "s1.json");
  const before = `${JSON.stringify({ ...LEGACY, id: "s1" })}`;
  writeFileSync(legacyFile, before, "utf8");

  const loaded = loadSessionTree("s1", { dir, legacyDir });
  saveSessionTree({ id: "s1", tree: loaded.tree, meta: loaded.meta, dir });

  assert.equal(readFileSync(legacyFile, "utf8"), before, "migration must not rewrite the original");
  assert.equal(loadSessionTree("s1", { dir }).source, "tree", "the tree lands in its own store");
});

test("a saved tree takes precedence over a legacy file with the same id", () => {
  const { dir, legacyDir } = tmpDirs();
  writeFileSync(join(legacyDir, "s1.json"), JSON.stringify({ ...LEGACY, id: "s1" }), "utf8");
  saveSessionTree({ id: "s1", tree: line(1), dir });

  const loaded = loadSessionTree("s1", { dir, legacyDir });
  assert.equal(loaded.source, "tree");
  assert.equal(loaded.migrated, false);
  assert.deepEqual(deriveContext(loaded.tree).messages.map((m) => m.content), ["q1", "a1"]);
});

test("shape detection never confuses a tree file with a legacy one", () => {
  assert.equal(detectShape(serializeTree({ id: "s1", tree: line(1) })), "tree");
  assert.equal(detectShape(LEGACY), "legacy");
  assert.equal(detectShape({ id: "s1", model: "m" }), "unknown");
  assert.equal(detectShape(null), "unknown");
  assert.equal(detectShape([]), "unknown");
  // The format tag decides on its own: a file claiming to be a tree is read as
  // one even if it also has a messages array, rather than being "migrated".
  assert.equal(detectShape({ format: SESSION_TREE_FORMAT, messages: [] }), "tree");
});

test("an envelope carries no top-level messages array, so it can never read as legacy", () => {
  const envelope = serializeTree({ id: "s1", tree: line(1), meta: { summary: "s" } });
  assert.equal("messages" in envelope, false);
  assert.equal(envelope.format, SESSION_TREE_FORMAT);
  assert.equal(envelope.version, SESSION_TREE_VERSION);
});

test("a missing session is null, which is not the same as a damaged one", () => {
  const { dir, legacyDir } = tmpDirs();
  assert.equal(loadSessionTree("nope", { dir, legacyDir }), null);
});

test("an unparseable session file throws instead of loading as empty", () => {
  const { dir, legacyDir } = tmpDirs();
  writeFileSync(join(dir, "s1.json"), "{ this is not json", "utf8");
  // Loading empty would let the next save overwrite a file we merely failed to
  // read, turning a recoverable problem into a permanent one.
  assert.throws(() => loadSessionTree("s1", { dir, legacyDir }), /unreadable/);
});

test("a file that is neither shape throws rather than being guessed at", () => {
  const { dir, legacyDir } = tmpDirs();
  writeFileSync(join(legacyDir, "s1.json"), JSON.stringify({ id: "s1", notes: "hand edited" }), "utf8");
  assert.throws(() => loadSessionTree("s1", { dir, legacyDir }), /neither a session tree nor a legacy session/);
});

test("a tree entry with no id is refused, because its children cannot be placed", () => {
  const envelope = serializeTree({ id: "s1", tree: line(1) });
  envelope.entries[0] = { type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "q1" } };
  assert.throws(() => deserializeTree(envelope), /entry without an id/);
});

test("a file with no entries array is reported as a broken tree, not as a legacy session", () => {
  assert.throws(() => deserializeTree({ format: SESSION_TREE_FORMAT, version: 1 }), /no entries array/);
});

test("a file written by a newer format version is refused rather than silently downgraded", () => {
  const envelope = { ...serializeTree({ id: "s1", tree: line(1) }), version: SESSION_TREE_VERSION + 1 };
  assert.throws(() => deserializeTree(envelope), /newer than this build understands/);
});

test("a dangling leaf falls back to the last entry so no history is stranded", () => {
  const envelope = { ...serializeTree({ id: "s1", tree: line(2) }), leafId: "ghost" };
  const loaded = deserializeTree(envelope);
  assert.equal(loaded.leafRepaired, true);
  assert.equal(loaded.tree.leafId, "a2");
  assert.equal(loaded.tree.entries.length, 4, "every entry survives the repair");
});

test("metadata round-trips alongside the tree", () => {
  const { dir } = tmpDirs();
  const meta = { summary: "so far", contextEpoch: { date: "x" }, checkpoints: [{ index: 1 }], plan: null };
  saveSessionTree({ id: "s1", tree: line(1), meta, dir, now: 42 });

  const loaded = loadSessionTree("s1", { dir });
  assert.deepEqual(loaded.meta, meta);
  assert.equal(loaded.updatedAt, 42);
  assert.equal(loaded.id, "s1");
});

test("an empty tree round-trips without becoming a broken one", () => {
  const { dir } = tmpDirs();
  saveSessionTree({ id: "s1", tree: createTree({ now: 1 }), dir });

  const loaded = loadSessionTree("s1", { dir });
  assert.equal(loaded.tree.leafId, null);
  assert.equal(loaded.tree.byId.size, 0);
  assert.deepEqual(deriveContext(loaded.tree).messages, []);
  // A tree loaded from disk must still be appendable.
  const grown = append(loaded.tree, msg("user", "first"), { id: "u1" });
  assert.deepEqual(deriveContext(grown).messages, [{ role: "user", content: "first" }]);
});

test("a legacy session with no messages migrates to an empty derivable context", () => {
  const { dir, legacyDir } = tmpDirs();
  writeFileSync(join(legacyDir, "s1.json"), JSON.stringify({ id: "s1", model: "m", cwd: "/w", messages: [] }), "utf8");
  const loaded = loadSessionTree("s1", { dir, legacyDir });
  assert.deepEqual(deriveContext(loaded.tree).messages, []);
  assert.deepEqual(deriveState(currentPath(loaded.tree)), { model: "m", cwd: "/w" });
});

test("a session id cannot escape its directory", () => {
  const { dir, legacyDir } = tmpDirs();
  saveSessionTree({ id: "../escape", tree: line(1), dir });
  assert.equal(loadSessionTree("..escape", { dir, legacyDir }).tree.entries.length, 2);
});
