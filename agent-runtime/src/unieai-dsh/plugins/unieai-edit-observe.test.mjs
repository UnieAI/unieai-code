// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RelaxedObservationGate, apply as applyObserve, pathsInCommand, shellWords } from "./unieai-edit-observe.mjs";
import { fakeCtx, fakeExec, fakeFs, tempWorkspace } from "./unieai-edit-testkit.mjs";

const target = { targetKey: "/w/a.py", displayPath: "/w/a.py" };

test("gate: unobserved edits and writes are allowed", async () => {
  const gate = new RelaxedObservationGate({ stat: async () => undefined });
  const actor = { agent: { session: {} } };
  assert.equal(await gate.editIntent(target, actor), undefined);
  assert.equal(await gate.writeIntent(target, actor), undefined);
  const strict = new RelaxedObservationGate({ stat: async () => undefined, requireReadBeforeOverwrite: true });
  assert.deepEqual(await strict.writeIntent(target, actor), { kind: "createIfAbsent" });
});

test("gate: an observed file keeps its version guard, per session", async () => {
  const gate = new RelaxedObservationGate({ stat: async () => undefined });
  const a = { agent: { session: {} } };
  const b = { agent: { session: {} } };
  gate.observe(target, { kind: "present", version: "v1" }, a);
  assert.deepEqual(await gate.editIntent(target, a), { version: "v1" });
  assert.deepEqual(await gate.writeIntent(target, a), { kind: "replaceIfVersion", version: "v1" });
  assert.equal(await gate.editIntent(target, b), undefined);
});

test("gate: absent then created by a command uses the current version", async () => {
  let info;
  const gate = new RelaxedObservationGate({ stat: async () => info });
  const a = { agent: { session: {} } };
  gate.observe(target, { kind: "absent" }, a);
  await assert.rejects(gate.editIntent(target, a), { code: "FS_NOT_FOUND" });
  info = { version: "v9", type: "file" };
  assert.deepEqual(await gate.editIntent(target, a), { version: "v9" });
});

test("shell words and paths", () => {
  assert.deepEqual(shellWords(`sed -n '1,80p' "my file.py" | grep -n foo&&cat a/b.txt`), [
    "sed", "-n", "1,80p", "my file.py", "|", "grep", "-n", "foo", "&", "&", "cat", "a/b.txt",
  ]);
  assert.deepEqual(pathsInCommand(`sed -n '1,80p' "my file.py" | grep -n foo && cat a/b.txt`), ["my file.py", "a/b.txt"]);
  assert.deepEqual(pathsInCommand("cat $HOME/x.py *.py http://x.y/z ls"), []);
  assert.deepEqual(pathsInCommand("FOO=1 python3 -m pytest tests/test_a.py -k 'x.y'"), ["tests/test_a.py", "x.y"]);
});

test("a bash read makes later edits version-guarded", async () => {
  const root = tempWorkspace("unieai-edit-observe-");
  const ctx = fakeCtx(fakeFs(root));
  applyObserve(ctx, {});
  const session = { header: { cwd: root } };
  writeFileSync(join(root, "m.py"), "x = 1\n");
  const exec = fakeExec("bash", { command: "cat m.py", description: "show" }, session);
  // tools/result listeners are async; await them
  await Promise.all((ctx.hooks["tools/result"] ?? []).map((fn) => fn(exec, { isError: false, value: { kind: "foreground" } })));
  const t = await ctx.fs.resolve(join(root, "m.py"));
  const guard = await ctx.waterfall("fs/edit-intent", t, fakeExec("edit", {}, session), () => undefined);
  assert.equal(guard.version, (await ctx.fs.stat(t)).version);
  // another session never saw it
  assert.equal(await ctx.waterfall("fs/edit-intent", t, fakeExec("edit", {}, { header: { cwd: root } }), () => undefined), undefined);
  // failed commands do not count
  const other = { header: { cwd: root } };
  await Promise.all(ctx.hooks["tools/result"].map((fn) => fn(fakeExec("bash", { command: "cat m.py" }, other), { isError: true })));
  assert.equal(await ctx.waterfall("fs/edit-intent", t, fakeExec("edit", {}, other), () => undefined), undefined);
});

test("prompt section corrects the edit tool's read-first rule", () => {
  const sections = [];
  const ctx = fakeCtx(fakeFs("/"), {
    systemPrompt: { section: (s) => sections.push(s), getSectionOrder: (n) => (n === "TOOL_EDIT" ? 1300 : undefined) },
    tools: { get: () => ({}) },
  });
  applyObserve(ctx, {});
  assert.equal(sections[0].order, 1301);
  assert.match(sections[0].text({ scope: undefined }), /do not have to open a file with the read tool/);
});
