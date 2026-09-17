// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { apply as applyFeedback, changedFiles } from "./unieai-edit-feedback.mjs";
import { fakeCtx, fakeExec, fakeFs, runTool, textOf } from "./unieai-edit-testkit.mjs";

const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "pass"]);
    return true;
  } catch {
    return false;
  }
})();

function setup(config = {}) {
  const ctx = fakeCtx(fakeFs("/"));
  applyFeedback(ctx, config);
  const run = (name, value, args = {}) =>
    runTool(ctx, fakeExec(name, args), async () => ({
      isError: false,
      value,
      content: [{ type: "text", text: "The file has been updated successfully." }],
    }));
  return { ctx, run };
}

test("changedFiles reads edit, write and apply_patch values", () => {
  assert.deepEqual(changedFiles("edit", { path: "a", before: "x", after: "y" }), [{ path: "a", before: "x", after: "y", created: false }]);
  assert.deepEqual(changedFiles("write", { path: "a", operation: "create", before: null, after: "y" })[0].created, true);
  assert.deepEqual(
    changedFiles("apply_patch", {
      summary: "",
      files: [
        { kind: "add", path: "n", before: null, after: "1\n" },
        { kind: "update", path: "o", movePath: "p", before: "a", after: "b" },
        { kind: "delete", path: "d", before: "x", after: null },
      ],
    }).map((f) => [f.path, f.created]),
    [["n", true], ["p", false]],
  );
});

test("an edit result gains a unified diff", async () => {
  const { run } = setup({ syntaxCheck: false });
  const r = await run("edit", { path: "/w/a.txt", before: "one\ntwo\nthree\n", after: "one\n2\nthree\n" });
  assert.equal(
    textOf(r),
    "The file has been updated successfully.\nDiff of /w/a.txt (+1 -1):\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three",
  );
});

test("new files are summarized, other tools and failures are untouched", async () => {
  const { ctx, run } = setup({ syntaxCheck: false });
  const created = await run("write", { path: "/w/n.txt", operation: "create", before: null, after: "a\nb\n" });
  assert.match(textOf(created), /\/w\/n\.txt: new file, 2 lines\.$/);
  const bash = await run("bash", { path: "/w/x", before: "a", after: "b" });
  assert.equal(textOf(bash), "The file has been updated successfully.");
  const failed = await runTool(ctx, fakeExec("edit", {}), async () => ({ isError: true, content: [{ type: "text", text: "Error: x" }], error: { message: "x" } }));
  assert.equal(textOf(failed), "Error: x");
});

test("diffs are capped", async () => {
  const { run } = setup({ syntaxCheck: false, maxDiffLines: 5 });
  const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace(/l(\d+)/g, "L$1");
  const r = await run("edit", { path: "/w/big.txt", before, after });
  assert.match(textOf(r), /more diff lines omitted/);
});

test("python syntax check: ok, broken, and already broken", { skip: !hasPython }, async () => {
  const { run } = setup();
  const ok = await run("edit", { path: "/w/m.py", before: "x = 1\n", after: "x = 2\n" });
  assert.match(textOf(ok), /Syntax check \(python compile\) of \/w\/m\.py: OK\./);
  const broken = await run("edit", { path: "/w/m.py", before: "x = 1\n", after: "def f(:\n    pass\n" });
  assert.match(textOf(broken), /FAILED — this change broke the file:\n[\s\S]*SyntaxError/);
  assert.match(textOf(broken), /m\.py", line 1/);
  assert.doesNotMatch(textOf(broken), /Traceback|<string>/);
  const still = await run("edit", { path: "/w/m.py", before: "def f(:\n", after: "def f(:\n  x\n" });
  assert.match(textOf(still), /still fails \(the file already failed before this change\)/);
});

test("the syntax check goes through ctx.shell when mounted", async () => {
  const seen = [];
  const shell = {
    resolve: (req) => (seen.push(req), req),
    run: async () => ({ exitCode: 1, stderr: { text: '  File "m.py", line 1\nSyntaxError: invalid syntax' }, stdout: { text: "" } }),
  };
  const ctx = fakeCtx(fakeFs("/"), { shell });
  applyFeedback(ctx, {});
  const r = await runTool(ctx, fakeExec("edit", {}, { header: { cwd: "/w" } }), async () => ({
    isError: false,
    value: { path: "/w/m.py", before: "", after: "def(" },
    content: [{ type: "text", text: "ok" }],
  }));
  assert.match(textOf(r), /FAILED/);
  assert.equal(seen[0].workdir, "/w");
  assert.equal(seen[0].stdin, "def(");
  assert.match(seen[0].command, /^python3 -c 'import sys;.*' '\/w\/m\.py'$/);
});
