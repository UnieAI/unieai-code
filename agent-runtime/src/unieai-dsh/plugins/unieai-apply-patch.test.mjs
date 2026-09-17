// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyChunks, parsePatch, summarize, unwrapPatch } from "./unieai-apply-patch-core.mjs";
import { apply as applyApplyPatch, createApplyPatchTool, previewDiffs, runApplyPatch } from "./unieai-apply-patch.mjs";
import { apply as applyObservationGate } from "./unieai-edit-observe.mjs";
import { fakeCtx, fakeExec, fakeFs, tempWorkspace } from "./unieai-edit-testkit.mjs";

const wrap = (body) => `*** Begin Patch\n${body}\n*** End Patch`;
const chunk = (o) => ({ context: null, oldLines: [], newLines: [], contextIndices: [], isEndOfFile: false, ...o });

// ---- parser (codex parser.rs / streaming_parser.rs cases) ----

test("parse: boundary errors", () => {
  assert.throws(() => parsePatch("bad"), { message: "invalid patch: The first line of the patch must be '*** Begin Patch'" });
  assert.throws(() => parsePatch("*** Begin Patch\nbad"), { message: "invalid patch: The last line of the patch must be '*** End Patch'" });
});

test("parse: markers with surrounding spaces", () => {
  const { hunks } = parsePatch("*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch");
  assert.deepEqual(hunks, [{ kind: "add", path: "foo", contents: "hi\n" }]);
});

test("parse: empty update hunk", () => {
  assert.throws(() => parsePatch(wrap("*** Update File: test.py")), {
    message: "invalid hunk at line 2, Update file hunk for path 'test.py' is empty",
  });
});

test("parse: no hunks is allowed", () => {
  assert.deepEqual(parsePatch("*** Begin Patch\n*** End Patch").hunks, []);
});

test("parse: add, delete, update with move and context", () => {
  const { hunks } = parsePatch(
    wrap(
      "*** Add File: path/add.py\n+abc\n+def\n*** Delete File: path/delete.py\n*** Update File: path/update.py\n*** Move to: path/update2.py\n@@ def f():\n-    pass\n+    return 123",
    ),
  );
  assert.deepEqual(hunks, [
    { kind: "add", path: "path/add.py", contents: "abc\ndef\n" },
    { kind: "delete", path: "path/delete.py" },
    {
      kind: "update",
      path: "path/update.py",
      movePath: "path/update2.py",
      chunks: [chunk({ context: "def f():", oldLines: ["    pass"], newLines: ["    return 123"] })],
    },
  ]);
});

test("parse: update followed by add; first chunk without @@", () => {
  const a = parsePatch(wrap("*** Update File: file.py\n@@\n+line\n*** Add File: other.py\n+content")).hunks;
  assert.deepEqual(a[0].chunks, [chunk({ newLines: ["line"] })]);
  assert.equal(a[1].contents, "content\n");
  const b = parsePatch(wrap("*** Update File: file2.py\n import foo\n+bar")).hunks;
  assert.deepEqual(b[0].chunks, [chunk({ oldLines: ["import foo"], newLines: ["import foo", "bar"], contextIndices: [[0, 0]] })]);
});

test("parse: end of file marker", () => {
  const { hunks } = parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch");
  assert.deepEqual(hunks[0].chunks, [chunk({ newLines: ["quux"], isEndOfFile: true })]);
});

test("parse: invalid lines", () => {
  assert.throws(() => parsePatch(wrap("*** Frobnicate File: foo")), {
    message:
      "invalid hunk at line 2, '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
  });
  assert.throws(() => parsePatch(wrap("*** Update File: a\n@@\n context\nbad line")), {
    message: "invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: 'bad line'",
  });
  assert.throws(() => parsePatch(wrap("*** Update File: a\n@@\n@@\n-x")), /Unexpected line found in update hunk: '@@'/);
  assert.throws(() => parsePatch(wrap("*** Update File: a\n@@")), /Update hunk does not contain any lines/);
});

test("parse: blank line inside a hunk is an empty context line", () => {
  const { hunks } = parsePatch(wrap("*** Update File: a\n@@\n x\n\n-y\n+z"));
  assert.deepEqual(hunks[0].chunks[0], chunk({ oldLines: ["x", "", "y"], newLines: ["x", "", "z"], contextIndices: [[0, 0], [1, 1]] }));
});

test("parse: heredoc and apply_patch wrappers", () => {
  const body = wrap("*** Add File: a\n+x");
  assert.equal(unwrapPatch(`<<'EOF'\n${body}\nEOF`), body);
  assert.equal(unwrapPatch(`apply_patch <<"EOF"\n${body}\nEOF\n`), body);
  assert.equal(parsePatch(`<<EOF\n${body}\nEOF`).hunks.length, 1);
});

test("parse: environment id", () => {
  const r = parsePatch("*** Begin Patch\n*** Environment ID: dev\n*** Add File: a\n+x\n*** End Patch");
  assert.equal(r.environmentId, "dev");
});

// ---- applying chunks (codex file_update / lib tests) ----

test("applyChunks: multiple chunks in order", () => {
  const chunks = parsePatch(wrap("*** Update File: m\n@@\n foo\n-bar\n+BAR\n@@\n baz\n-qux\n+QUX")).hunks[0].chunks;
  assert.equal(applyChunks("foo\nbar\nbaz\nqux\n", chunks, "m"), "foo\nBAR\nbaz\nQUX\n");
});

test("applyChunks: pure insertion goes to the end", () => {
  assert.equal(applyChunks("foo\nbar\nbaz\n", [chunk({ newLines: ["quux"] })], "p"), "foo\nbar\nbaz\nquux\n");
});

test("applyChunks: context header locates the change", () => {
  const src = "def a():\n    pass\n\ndef b():\n    pass\n";
  const { hunks } = parsePatch(wrap("*** Update File: p\n@@ def b():\n-    pass\n+    return 1"));
  assert.equal(applyChunks(src, hunks[0].chunks, "p"), "def a():\n    pass\n\ndef b():\n    return 1\n");
});

test("applyChunks: fuzzy whitespace and punctuation (context lines keep file text)", () => {
  const src = "x = 1   \n\tif y:\n  print(\u201chi\u201d)\n";
  const { hunks } = parsePatch(wrap('*** Update File: p\n@@\n x = 1\n if y:\n-print("hi")\n+print("bye")'));
  assert.equal(applyChunks(src, hunks[0].chunks, "p"), 'x = 1   \n\tif y:\nprint("bye")\n');
});

test("applyChunks: spaces written for a tab-indented file are re-indented", () => {
  const src = "class C:\n\tdef sub(self, a, b):\n\t\treturn a - b\n";
  const { hunks } = parsePatch(wrap("*** Update File: p\n@@ def sub(self, a, b):\n-    return a - b\n+    if a:\n+        return b - a"));
  assert.equal(applyChunks(src, hunks[0].chunks, "p"), "class C:\n\tdef sub(self, a, b):\n\t\tif a:\n\t\t\treturn b - a\n");
});

test("applyChunks: end of file anchoring and trailing-empty retry", () => {
  const src = "a\nb\na\nb\n";
  assert.equal(applyChunks(src, [chunk({ oldLines: ["a", "b"], newLines: ["A", "B"], isEndOfFile: true })], "p"), "a\nb\nA\nB\n");
  assert.equal(applyChunks("x\ny\n", [chunk({ oldLines: ["y", ""], newLines: ["Y", ""] })], "p"), "x\nY\n");
  assert.equal(applyChunks("no newline", [chunk({ oldLines: ["no newline"], newLines: ["with"] })], "p"), "with\n");
});

test("applyChunks: codex error messages", () => {
  assert.throws(() => applyChunks("a\n", [chunk({ context: "nope", oldLines: ["a"], newLines: ["b"] })], "f.py"), {
    message: "Failed to find context 'nope' in f.py",
  });
  assert.throws(() => applyChunks("a\n", [chunk({ oldLines: ["x", "y"], newLines: ["z"] })], "f.py"), {
    message: "Failed to find expected lines in f.py:\nx\ny",
  });
});

test("summarize prints codex's summary", () => {
  assert.equal(
    summarize([{ kind: "add", path: "a" }, { kind: "update", path: "b", movePath: "c" }, { kind: "delete", path: "d" }]),
    "Success. Updated the following files:\nA a\nM c\nD d",
  );
});

// ---- the tool, against a fake dsh fs ----

function setup({ gate = false } = {}) {
  const root = tempWorkspace("unieai-apply-patch-");
  const fs = fakeFs(root);
  const ctx = fakeCtx(fs);
  if (gate) applyObservationGate(ctx, { prompt: false });
  const session = { header: { cwd: root } };
  const exec = () => fakeExec("apply_patch", {}, session);
  return { root, fs, ctx, exec, session };
}

test("tool: multi-file add / update / move / delete in one call", async () => {
  const { root, ctx, exec } = setup();
  writeFileSync(join(root, "keep.py"), "def f():\n    return 1   \n");
  writeFileSync(join(root, "old.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(root, "gone.txt"), "bye\n");
  const patch = wrap(
    [
      "*** Add File: pkg/new.py",
      "+print('new')",
      "*** Update File: keep.py",
      "@@ def f():",
      "-    return 1",
      "+    return 2",
      "*** Update File: old.txt",
      "*** Move to: moved/renamed.txt",
      "@@",
      " one",
      "-two",
      "+TWO",
      "*** Delete File: gone.txt",
    ].join("\n"),
  );
  const value = await runApplyPatch(ctx, exec(), patch);
  assert.equal(
    value.summary,
    `Success. Updated the following files:\nA ${join(root, "pkg/new.py")}\nM ${join(root, "keep.py")}\nM ${join(root, "moved/renamed.txt")}\nD ${join(root, "gone.txt")}`,
  );
  assert.equal(readFileSync(join(root, "pkg/new.py"), "utf8"), "print('new')\n");
  assert.equal(readFileSync(join(root, "keep.py"), "utf8"), "def f():\n    return 2\n");
  assert.equal(readFileSync(join(root, "moved/renamed.txt"), "utf8"), "one\r\nTWO\r\n");
  assert.equal(existsSync(join(root, "old.txt")), false);
  assert.equal(existsSync(join(root, "gone.txt")), false);
  assert.deepEqual(
    value.files.map((f) => [f.kind, f.before === null, f.after === null]),
    [["add", true, false], ["update", false, false], ["update", false, false], ["delete", false, true]],
  );
  // the value satisfies the tool's own output schema
  const tool = createApplyPatchTool(ctx);
  const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, "value"), []);
  assert.match(tool.output.render({}, value)[0].text, /^Success\./);
  assert.equal(tool.output.presentationMeta({}, value).diffs.length, 4);
});

test("tool: a hunk that does not apply changes nothing", async () => {
  const { root, fs, ctx, exec } = setup();
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  const patch = wrap("*** Update File: a.txt\n-a\n+A\n*** Update File: b.txt\n-nope\n+B\n*** Add File: c.txt\n+c");
  await assert.rejects(runApplyPatch(ctx, exec(), patch), {
    message: `apply_patch verification failed: Failed to find expected lines in ${join(root, "b.txt")}:\nnope`,
  });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(root, "c.txt")), false);
  assert.deepEqual(fs.calls, []);
});

test("tool: parse errors and missing files are reported codex-style", async () => {
  const { ctx, exec } = setup();
  await assert.rejects(runApplyPatch(ctx, exec(), "hello"), /apply_patch verification failed: invalid patch: The first line/);
  await assert.rejects(
    runApplyPatch(ctx, exec(), wrap("*** Delete File: missing.txt")),
    /Failed to read file to delete .*missing\.txt: No such file or directory/,
  );
  await assert.rejects(
    runApplyPatch(ctx, exec(), wrap("*** Add File: x\n+1\n*** Delete File: x")),
    /multiple operations target .*x/,
  );
});

test("tool: a write failure mid-patch rolls back earlier files", async () => {
  const { root, fs, ctx, exec } = setup();
  writeFileSync(join(root, "a.txt"), "a\n");
  fs.failWrite = (p) => p.endsWith("z.txt");
  await assert.rejects(runApplyPatch(ctx, exec(), wrap("*** Update File: a.txt\n-a\n+A\n*** Add File: new.txt\n+n\n*** Add File: z.txt\n+z")), (error) => {
    assert.match(error.message, /apply_patch failed on .*z\.txt: disk full/);
    assert.match(error.message, /Earlier files in this patch were restored/);
    return true;
  });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(root, "new.txt")), false);
});

test("tool: stale file (changed since observed) is refused before writing", async () => {
  const { root, ctx, exec } = setup({ gate: true });
  const file = join(root, "s.txt");
  writeFileSync(file, "v1\n");
  const e = exec();
  const target = await ctx.fs.resolve(file);
  ctx.emit("fs/observed", target, { kind: "present", version: (await ctx.fs.stat(target)).version }, e);
  writeFileSync(file, "v2 longer\n");
  await assert.rejects(runApplyPatch(ctx, e, wrap("*** Update File: s.txt\n-v2 longer\n+v3")), /file changed since it was read/);
  assert.equal(readFileSync(file, "utf8"), "v2 longer\n");
  // After re-observing, it applies; the observation is refreshed afterwards.
  ctx.emit("fs/observed", target, { kind: "present", version: (await ctx.fs.stat(target)).version }, e);
  await runApplyPatch(ctx, e, wrap("*** Update File: s.txt\n-v2 longer\n+v3"));
  await runApplyPatch(ctx, e, wrap("*** Update File: s.txt\n-v3\n+v4"));
  assert.equal(readFileSync(file, "utf8"), "v4\n");
});

test("tool: sandbox fence denies deleting outside writable roots", async () => {
  const { root, ctx, session } = setup();
  const outside = tempWorkspace("unieai-apply-patch-outside-");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "x.txt"), "x\n");
  ctx.fs.sandboxMode = "workspace-write";
  const policy = { mode: "workspace-write", workspaceRoot: root };
  const services = { sandboxPolicy: { resolve: () => policy } };
  ctx.get = (n) => (n === "fs" ? ctx.fs : services[n]);
  const e = fakeExec("apply_patch", {}, session);
  // /tmp is itself a writable root in dsh; use a read-only policy to see the fence.
  policy.mode = "read-only";
  await assert.rejects(runApplyPatch(ctx, e, wrap(`*** Delete File: ${join(outside, "x.txt")}`)), /read-only mode/);
  assert.equal(existsSync(join(outside, "x.txt")), true);
});

test("tool: registration and call preview", () => {
  const registered = [];
  const sections = [];
  const ctx = fakeCtx(fakeFs("/"), {
    tools: { register: (t) => registered.push(t), get: () => ({}) },
    systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 1300 },
  });
  applyApplyPatch(ctx, {});
  assert.equal(registered[0].name, "apply_patch");
  assert.equal(sections[0].name, "unieai:apply-patch");
  assert.match(sections[0].text({ scope: undefined }), /apply_patch tool/);
  assert.deepEqual(previewDiffs(wrap("*** Add File: a\n+x")), [{ path: "a", oldText: null, newText: "x\n" }]);
  assert.equal(registered[0].presentCall({ input: "junk" }).card, "generic");
});
