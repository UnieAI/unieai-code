// The apply_patch envelope, against the grammar codex defines
// (codex-rs/apply-patch/src/parser.rs) and the cases its own tests cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePatch, applyUpdate, PatchError } from "./apply-patch.mjs";

const wrap = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

test("an add hunk carries the new file's lines", () => {
  const [hunk] = parsePatch(wrap("*** Add File: a/b.txt\n+one\n+two"));
  assert.equal(hunk.kind, "add");
  assert.equal(hunk.path, "a/b.txt");
  assert.deepEqual(hunk.lines, ["one", "two"]);
});

test("a delete hunk is just the path", () => {
  const [hunk] = parsePatch(wrap("*** Delete File: gone.txt"));
  assert.deepEqual({ kind: hunk.kind, path: hunk.path }, { kind: "delete", path: "gone.txt" });
});

test("an update hunk parses its chunks, with or without a @@ header", () => {
  const [hunk] = parsePatch(wrap("*** Update File: f.py\n foo\n-bar\n+BAR"));
  assert.equal(hunk.kind, "update");
  assert.equal(hunk.chunks.length, 1);
  assert.deepEqual(hunk.chunks[0].ops, [
    { op: " ", text: "foo" },
    { op: "-", text: "bar" },
    { op: "+", text: "BAR" },
  ]);
});

test("several chunks in one file are kept apart", () => {
  const [hunk] = parsePatch(wrap("*** Update File: f.py\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX"));
  assert.equal(hunk.chunks.length, 2);
});

test("a move is recorded alongside the update", () => {
  const [hunk] = parsePatch(wrap("*** Update File: old.txt\n*** Move to: new.txt\n@@\n-line\n+line2"));
  assert.equal(hunk.moveTo, "new.txt");
});

test("several files in one patch stay in order", () => {
  const hunks = parsePatch(wrap("*** Add File: a.txt\n+a\n*** Delete File: b.txt\n*** Update File: c.txt\n@@\n-c\n+C"));
  assert.deepEqual(hunks.map((h) => h.kind), ["add", "delete", "update"]);
});

test("a missing envelope is refused, and says which end", () => {
  assert.throws(() => parsePatch("*** Add File: x\n+y"), PatchError);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: x\n+y"), /End Patch/);
});

test("a line that is neither context nor change is refused", () => {
  // Silently skipping it would apply a patch the model did not write.
  assert.throws(() => parsePatch(wrap("*** Update File: f.py\n@@\nnot a diff line")), /unexpected line/);
});

test("an empty patch is refused rather than treated as a no-op", () => {
  assert.throws(() => parsePatch(wrap("")), /no hunks/);
});

// ── applying ─────────────────────────────────────────────────────────────────

const lines = (s) => s.split("\n");

test("a single chunk replaces exactly what it quoted", () => {
  const [hunk] = parsePatch(wrap("*** Update File: f\n@@\n foo\n-bar\n+BAR"));
  assert.deepEqual(applyUpdate(lines("foo\nbar\nbaz"), hunk.chunks), ["foo", "BAR", "baz"]);
});

test("two chunks apply to different places in one file", () => {
  const [hunk] = parsePatch(wrap("*** Update File: f\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX"));
  assert.deepEqual(
    applyUpdate(lines("foo\nbar\nbaz\nqux"), hunk.chunks),
    ["foo", "BAR", "baz", "QUX"]
  );
});

test("the scan is forward-only, so a later chunk cannot rematch earlier text", () => {
  // Both chunks quote the same line; each must land on its own occurrence.
  const [hunk] = parsePatch(wrap("*** Update File: f\n@@\n-dup\n+first\n@@\n-dup\n+second"));
  assert.deepEqual(applyUpdate(lines("dup\ndup"), hunk.chunks), ["first", "second"]);
});

test("pure insertion and pure deletion both work", () => {
  const [add] = parsePatch(wrap("*** Update File: f\n@@\n a\n+inserted\n b"));
  assert.deepEqual(applyUpdate(lines("a\nb"), add.chunks), ["a", "inserted", "b"]);
  const [del] = parsePatch(wrap("*** Update File: f\n@@\n a\n-gone\n b"));
  assert.deepEqual(applyUpdate(lines("a\ngone\nb"), del.chunks), ["a", "b"]);
});

test("a chunk whose quoted lines are not there fails loudly", () => {
  // The alternative — applying it somewhere plausible — is how a patch silently
  // corrupts a file.
  const [hunk] = parsePatch(wrap("*** Update File: f\n@@\n-missing\n+new"));
  assert.throws(() => applyUpdate(lines("something\nelse"), hunk.chunks), /could not find/);
});

test("a @@ header locates the chunk, and must itself exist", () => {
  const [hunk] = parsePatch(wrap("*** Update File: f\n@@ def second():\n-old\n+new"));
  assert.deepEqual(
    applyUpdate(lines("def first():\nold\ndef second():\nold"), hunk.chunks),
    ["def first():", "old", "def second():", "new"]
  );
  assert.throws(() => applyUpdate(lines("nothing here"), hunk.chunks), /context line not found/);
});
