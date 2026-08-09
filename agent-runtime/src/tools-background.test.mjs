import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds or the budget runs out. */
async function until(check, budgetMs = 4000) {
  for (let waited = 0; waited < budgetMs; waited += 50) {
    if (await check()) return true;
    await wait(50);
  }
  return false;
}

/**
 * A stand-in for the host sandbox binary that runs the command it is handed.
 *
 * The tool always wraps commands as `<sandboxBin> sandbox [opts] -- <shell> <cmd>`,
 * and deliberately offers no way to skip that. Pointing sandboxBin at a real
 * shell makes every command die with "sandbox: No such file or directory"
 * (exit 127) — which still looks like a process that started and exited, so
 * assertions about listing and stopping pass while nothing was ever actually
 * run. The stub drops everything up to `--` so it stays correct as sandbox
 * options are added.
 */
async function tools() {
  const root = await mkdtemp(join(tmpdir(), "unieai-bg-"));
  const stub = join(root, "sandbox-stub.sh");
  await writeFile(stub, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', "utf8");
  await chmod(stub, 0o755);
  return { root, t: await buildCodingTools({ workspace: root, sandboxBin: stub })() };
}

test("the background tools are registered", async () => {
  const { t } = await tools();
  const names = t.schemas.map((s) => s.function.name);
  for (const n of ["run_background", "list_processes", "read_process", "stop_process"]) {
    assert.ok(names.includes(n), `${n} is missing`);
  }
});

test("a command runs in the background and its output is readable", async () => {
  const { t } = await tools();
  const started = await t.executors.run_background({ command: "echo first; sleep 5" });
  assert.equal(started.ok, true, started.modelText);
  const id = started.modelText.match(/Started (bg_\d+)/)?.[1];
  assert.ok(id, `no handle in: ${started.modelText}`);

  assert.ok(await until(async () => (await t.executors.read_process({ id })).modelText.includes("first")));
  await t.executors.stop_process({ id });
});

test("a cursor returns only what is new, which is how polling stays cheap", async () => {
  const { t } = await tools();
  const started = await t.executors.run_background({ command: "echo one; sleep 0.4; echo two; sleep 5" });
  const id = started.modelText.match(/Started (bg_\d+)/)?.[1];

  await until(async () => (await t.executors.read_process({ id })).modelText.includes("one"));
  const first = await t.executors.read_process({ id });
  const cursor = Number(first.modelText.match(/cursor (\d+)/)?.[1]);
  assert.ok(Number.isFinite(cursor));

  assert.ok(await until(async () => (await t.executors.read_process({ id, cursor })).modelText.includes("two")));
  const second = await t.executors.read_process({ id, cursor });
  assert.ok(!second.modelText.includes("one"), "the cursor re-sent output already seen");

  await t.executors.stop_process({ id });
});

test("listing shows a running process and then its exit", async () => {
  const { t } = await tools();
  const started = await t.executors.run_background({ command: "exit 3" });
  const id = started.modelText.match(/Started (bg_\d+)/)?.[1];

  assert.ok(await until(async () => {
    const listed = await t.executors.list_processes({});
    return listed.modelText.includes(id) && /exit 3/.test(listed.modelText);
  }), "the exit code never surfaced in the listing");
});

test("stopping kills the process and everything it started", async () => {
  const { t } = await tools();
  const started = await t.executors.run_background({ command: "sleep 30 & wait" });
  const id = started.modelText.match(/Started (bg_\d+)/)?.[1];

  await until(async () => (await t.executors.list_processes({})).modelText.includes("running"));
  const stopped = await t.executors.stop_process({ id });
  assert.equal(stopped.ok, true, stopped.modelText);

  assert.ok(await until(async () => !(await t.executors.list_processes({})).modelText.includes("running")));
});

test("stop_process with all: true clears everything", async () => {
  const { t } = await tools();
  await t.executors.run_background({ command: "sleep 30" });
  await t.executors.run_background({ command: "sleep 30" });
  const stopped = await t.executors.stop_process({ all: true });
  assert.match(stopped.modelText, /Stopped 2 process\(es\)/);
});

test("stop_process without an id or all says what it needs", async () => {
  const { t } = await tools();
  const r = await t.executors.stop_process({});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /needs an `id`/);
});

test("reading an unknown handle is an error the model can act on", async () => {
  const { t } = await tools();
  const r = await t.executors.read_process({ id: "bg_999" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /unknown process/);
});

test("an empty command is refused rather than spawning a shell that does nothing", async () => {
  const { t } = await tools();
  const r = await t.executors.run_background({ command: "   " });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /command is required/);
});

test("with nothing started, listing says so instead of showing an empty table", async () => {
  const { t } = await tools();
  assert.match((await t.executors.list_processes({})).modelText, /No background processes/);
});

test("two toolsets never see each other's processes", async () => {
  const a = await tools();
  const b = await tools();
  await a.t.executors.run_background({ command: "sleep 30" });
  assert.match((await b.t.executors.list_processes({})).modelText, /No background processes/);
  await a.t.executors.stop_process({ all: true });
});
