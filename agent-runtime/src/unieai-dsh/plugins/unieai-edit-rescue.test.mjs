// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { apply as applyRescue } from "./unieai-edit-rescue.mjs";
import { apply as applyObserve } from "./unieai-edit-observe.mjs";
import { fakeCtx, fakeExec, fakeFs, runTool, tempWorkspace, textOf } from "./unieai-edit-testkit.mjs";

/** dsh's `edit` tool body, reduced: literal edit, errors as tool results. */
function editBody(ctx, exec) {
  return async () => {
    const a = exec.arguments;
    const target = await ctx.fs.resolve(a.file_path, { cwd: exec.agent.session.header.cwd });
    try {
      const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => undefined);
      const out = await ctx.fs.editText(target, { oldString: a.old_string, newString: a.new_string, replaceAll: a.replace_all ?? false }, intent);
      ctx.emit("fs/observed", target, { kind: "present", version: out.version }, exec);
      return { isError: false, value: { path: target.displayPath, before: out.before, after: out.after }, content: [{ type: "text", text: `The file ${target.displayPath} has been updated successfully.` }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Error: ${error.message}` }], error: { message: error.message, info: { name: error.name, code: error.code } } };
    }
  };
}

function setup() {
  const root = tempWorkspace("unieai-edit-rescue-");
  const ctx = fakeCtx(fakeFs(root));
  applyObserve(ctx, { prompt: false });
  applyRescue(ctx, {});
  const session = { header: { cwd: root } };
  const call = (args) => {
    const exec = fakeExec("edit", { file_path: "f.py", replace_all: false, ...args }, session);
    const render = (_args, value) => [{ type: "text", text: `The file ${value.path} has been updated successfully.` }];
    return runTool(ctx, exec, editBody(ctx, exec), render);
  };
  return { root, ctx, call };
}

test("whitespace drift: the edit is applied and the note says how", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "def f(x):\n\tif x:  \n\t\treturn 1\n\treturn 0\n");
  const r = await call({ old_string: "    if x:\n        return 1", new_string: "    if x:\n        return 2" });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(readFileSync(join(root, "f.py"), "utf8"), "def f(x):\n\tif x:\n\t\treturn 2\n\treturn 0\n");
  assert.match(textOf(r), /updated successfully/);
  assert.match(textOf(r), /did not match verbatim; applied at line 2, ignoring leading\/trailing whitespace/);
  assert.equal(r.value.before.includes("return 1"), true);
});

test("CRLF files keep their line endings", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "a = 1 \r\nb = 2\r\n");
  const r = await call({ old_string: "a = 1\nb = 2", new_string: "a = 1\nb = 3" });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(readFileSync(join(root, "f.py"), "utf8"), "a = 1\r\nb = 3\r\n");
});

test("line-number prefixes copied from read are dropped", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "x = 1\ny = 2\n");
  const r = await call({ old_string: "2: y = 2", new_string: "2: y = 3" });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(readFileSync(join(root, "f.py"), "utf8"), "x = 1\ny = 3\n");
  assert.match(textOf(r), /after removing line-number prefixes/);
});

test("not found: the error names the closest lines", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "import os\n\ndef compute(a, b):\n    total = a + b\n    return total\n");
  const r = await call({ old_string: "def compute(a, b):\n    total = a * b", new_string: "x" });
  assert.equal(r.isError, true);
  const text = textOf(r);
  assert.match(text, /old_string was not found .*also tried ignoring whitespace/);
  assert.match(text, /Closest match is lines 3-4/);
  assert.match(text, /First difference at line 4/);
  assert.equal(r.error.info.code, "FS_EDIT_NOT_FOUND");
  assert.equal(readFileSync(join(root, "f.py"), "utf8").includes("a + b"), true);
});

test("ambiguous: exact duplicates get line numbers; fuzzy duplicates are refused", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "x = 1\ny\nx = 1\n");
  const r = await call({ old_string: "x = 1", new_string: "x = 2" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /matched 2 times.*occurrences start at line 1, 3/);
  writeFileSync(join(root, "f.py"), "  x = 1\ny\n x = 1\n");
  const r2 = await call({ old_string: "x = 1 ", new_string: "x = 2" });
  assert.equal(r2.isError, true);
  assert.match(textOf(r2), /matches 2 places \(starting at line 1, 3\)/);
  const r3 = await call({ old_string: "x = 1 ", new_string: "x = 2", replace_all: true });
  assert.equal(r3.isError, false, textOf(r3));
  assert.equal(readFileSync(join(root, "f.py"), "utf8"), "  x = 2\ny\n x = 2\n");
});

test("exact successes and other errors pass through untouched", async () => {
  const { root, call } = setup();
  writeFileSync(join(root, "f.py"), "a\n");
  const ok = await call({ old_string: "a", new_string: "b" });
  assert.equal(textOf(ok), `The file ${join(root, "f.py")} has been updated successfully.`);
  const missing = await call({ file_path: "nope.py", old_string: "a", new_string: "b" });
  assert.equal(missing.isError, true);
  assert.doesNotMatch(textOf(missing), /Closest/);
});

test("a file changed since the last edit is refused", async () => {
  const { root, call } = setup();
  const file = join(root, "f.py");
  writeFileSync(file, "v = 1  \n");
  const first = await call({ old_string: "v = 1  ", new_string: "v = 2  " });
  assert.equal(first.isError, false);
  writeFileSync(file, "v = 9   \n");
  const r = await call({ old_string: "v = 9", new_string: "v = 10" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /changed since it was read/);
});
