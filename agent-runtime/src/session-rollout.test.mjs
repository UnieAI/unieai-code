// The rollout exists for one situation: the process died mid-turn.
//
// The snapshot store writes the whole tree when a turn ends, so until then a
// crash lost everything the turn had done. Entries are now appended to a JSONL
// log the moment the tree gains them, and replayed onto the snapshot on load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "unieai-rollout-"));
process.env.UNIEAI_HOME = HOME;

const {
  appendRollout, readRollout, replayRollout, rolloutEntry, rolloutLeaf, rolloutMeta, rolloutPath,
} = await import("./session-rollout.mjs");
const { createTree, append, ENTRY_TYPES } = await import(
  "../../third_party/unieai-agent-core/src/session-tree.mjs"
);

const msg = (id, content, parentId = null) => ({
  id,
  parentId,
  type: ENTRY_TYPES.MESSAGE,
  at: 1,
  message: { role: "user", content },
});

test("records round-trip through the log", () => {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  appendRollout(id, [rolloutMeta({ id, cwd: "/w" }), rolloutEntry(msg("m0", "hello"))]);
  appendRollout(id, rolloutEntry(msg("m1", "again", "m0")));

  const out = readRollout(id);
  assert.equal(out.entries.length, 2);
  assert.deepEqual(out.entries.map((e) => e.id), ["m0", "m1"]);
  assert.equal(out.meta.cwd, "/w");
  assert.equal(out.skipped, 0);
});

test("a torn last line costs that line, not the session", () => {
  // The failure mode a JSONL log is chosen FOR: a partial write can only damage
  // the line being written.
  const id = `s-${Math.random().toString(36).slice(2)}`;
  appendRollout(id, [rolloutEntry(msg("m0", "kept")), rolloutEntry(msg("m1", "kept too", "m0"))]);
  const path = rolloutPath(id);
  writeFileSync(path, readFileSync(path, "utf8") + '{"v":1,"t":"entry","e":{"id":"m2"', "utf8");

  const out = readRollout(id);
  assert.deepEqual(out.entries.map((e) => e.id), ["m0", "m1"]);
  assert.equal(out.skipped, 1, "the torn line was not reported");
});

test("a missing log is not an error — most sessions predate it", () => {
  assert.deepEqual(readRollout("never-written"), { entries: [], leafId: null, meta: {}, skipped: 0 });
});

test("replay adds only what the snapshot is missing", () => {
  let tree = createTree({ now: 1 });
  tree = append(tree, { type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "one" } }, { id: "m0", now: 1 });
  const snapshot = tree;
  // The turn continued past the snapshot, and then the process died.
  const logged = {
    entries: [
      ...snapshot.entries,
      { id: "m1", parentId: "m0", type: ENTRY_TYPES.MESSAGE, at: 2, message: { role: "assistant", content: "two" } },
    ],
    leafId: "m1",
  };

  const { tree: recovered, replayed } = replayRollout(snapshot, logged);
  assert.equal(replayed, 1, "the entry the snapshot never saw was not recovered");
  assert.equal(recovered.entries.length, 2);
  assert.equal(recovered.leafId, "m1");
  assert.ok(recovered.byId.has("m1"));
});

test("replaying a log the snapshot already contains changes nothing", () => {
  let tree = createTree({ now: 1 });
  tree = append(tree, { type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "one" } }, { id: "m0", now: 1 });
  const { tree: after, replayed } = replayRollout(tree, { entries: tree.entries.slice(), leafId: "m0" });
  assert.equal(replayed, 0);
  assert.equal(after, tree, "an up-to-date snapshot was needlessly rebuilt");
});

test("an entry whose parent is unknown is refused, not grafted", () => {
  // It belongs to a branch this snapshot does not hold. Attaching it anyway
  // would invent a conversation that never happened.
  let tree = createTree({ now: 1 });
  tree = append(tree, { type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "one" } }, { id: "m0", now: 1 });
  const { replayed } = replayRollout(tree, { entries: [msg("x1", "orphan", "nonexistent")], leafId: "x1" });
  assert.equal(replayed, 0);
});

test("writing a rollout never throws at the caller", () => {
  // Insurance that fails must not take down the thing it was insuring.
  assert.equal(appendRollout("x", [{ t: "entry", e: { id: "a", self: null } }]), 1);
  assert.equal(appendRollout("x", []), 0);
  const circular = { t: "entry", e: { id: "c" } };
  circular.e.self = circular; // JSON.stringify throws on this
  assert.equal(appendRollout("x", [circular]), 0);
});
