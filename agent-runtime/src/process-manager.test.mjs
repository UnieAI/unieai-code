import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessManager, DEFAULTS } from "./process-manager.mjs";

// Everything here launches REAL processes, so a failed assertion must never be
// able to leave a `sleep 30` behind. Managers and temp dirs are registered on
// creation and torn down after every test, pass or fail.
const OPEN = [];
const TEMP = [];

function manager(options = {}) {
  const m = createProcessManager({ workspace: process.cwd(), ...options });
  OPEN.push(m);
  return m;
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP.push(dir);
  return dir;
}

afterEach(async () => {
  while (OPEN.length > 0) {
    const m = OPEN.pop();
    try { await m.dispose({ graceMs: 200 }); } catch { /* teardown is best-effort */ }
  }
  while (TEMP.length > 0) rmSync(TEMP.pop(), { recursive: true, force: true });
});

const POSIX = process.platform !== "win32";

/** Poll until `check` returns truthy, or give up — for output that arrives async. */
async function until(check, { timeoutMs = 5000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A stand-in for the sandbox binary that runs the wrapped command unchanged. */
function passthroughSandbox(dir) {
  const bin = join(dir, "passthrough-sandbox");
  // argv is `sandbox -- sh -c CMD`; drop the first two and exec the rest.
  writeFileSync(bin, '#!/bin/sh\nshift 2\nexec "$@"\n');
  chmodSync(bin, 0o755);
  return bin;
}

test("start returns a handle immediately and the process reaches exit code 0", { skip: !POSIX }, async () => {
  const m = manager();
  const started = m.start({ command: "echo hi", sandbox: false });

  assert.equal(started.ok, true);
  assert.match(started.id, /^bg_\d+$/, "handle is short enough for the model to echo back");
  assert.equal(started.process.status, "running", "start does not block until the command finishes");

  const exit = await m.waitForExit(started.id, { timeoutMs: 5000 });
  assert.ok(exit, "the process exited within the timeout");
  assert.equal(exit.status, "exited");
  assert.equal(exit.exitCode, 0);
  assert.ok(exit.uptimeMs >= 0);
});

test("stdout and stderr are captured and readable as one interleaved transcript", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "echo out; echo err >&2", sandbox: false });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const read = await until(() => {
    const r = m.read(id);
    return r.lines.includes("out") && r.lines.includes("err") ? r : null;
  });
  assert.ok(read, "both streams landed in the buffer");
  assert.equal(read.ok, true);
  assert.ok(read.outputBytes > 0, "output size is reported");
});

test("a non-zero exit status is preserved, not flattened to a generic failure", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "echo boom >&2; exit 42", sandbox: false });

  const exit = await m.waitForExit(id, { timeoutMs: 5000 });
  assert.equal(exit.status, "exited");
  assert.equal(exit.exitCode, 42);
  assert.equal(exit.signal, null);
});

test("reading with a cursor returns ONLY output that arrived since the last read", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "echo one; sleep 0.4; echo two", sandbox: false });

  const first = await until(() => {
    const r = m.read(id);
    return r.lines.includes("one") ? r : null;
  });
  assert.ok(first, "the first line showed up while the process was still running");
  assert.equal(first.running, true);
  assert.ok(!first.lines.includes("two"), "the second line has not been printed yet");

  await m.waitForExit(id, { timeoutMs: 5000 });
  const next = await until(() => {
    const r = m.read(id, { cursor: first.cursor });
    return r.lines.includes("two") ? r : null;
  });
  assert.ok(next, "polling with the cursor eventually sees the new line");
  assert.deepEqual(next.lines, ["two"], "and NOTHING that the previous read already returned");

  const empty = m.read(id, { cursor: next.cursor });
  assert.deepEqual(empty.lines, [], "a cursor at the head of the stream returns nothing");
  assert.equal(empty.cursor, next.cursor, "and does not move the cursor");
});

test("the output buffer is bounded: old lines are dropped and the loss is reported", { skip: !POSIX }, async () => {
  const m = manager({ maxLines: 50 });
  const { id } = m.start({
    command: `awk 'BEGIN{for(i=1;i<=500;i++)print "line" i}'`,
    sandbox: false,
  });
  await m.waitForExit(id, { timeoutMs: 10_000 });

  const read = await until(() => {
    const r = m.read(id, { tail: 1000 });
    return r.outputLines >= 500 ? r : null;
  });
  assert.ok(read, "all 500 lines passed through the buffer");
  assert.ok(read.lines.length <= 50, `buffer kept ${read.lines.length} lines, cap is 50`);
  assert.equal(read.lines[read.lines.length - 1], "line500", "the MOST RECENT output is what survives");
  assert.ok(read.droppedLines >= 450, "and the agent is told how much it lost");
  assert.ok(read.bufferedBytes < read.outputBytes, "bytes held is far below bytes produced");
});

test("the byte cap bounds a stream of very long lines even when the line count does not", { skip: !POSIX }, async () => {
  const m = manager({ maxLines: 10_000, maxBytes: 4096 });
  const { id } = m.start({
    command: `awk 'BEGIN{s="";for(i=0;i<500;i++)s=s "x"; for(i=1;i<=100;i++)print s}'`,
    sandbox: false,
  });
  await m.waitForExit(id, { timeoutMs: 10_000 });

  const read = await until(() => {
    const r = m.read(id, { tail: 10_000 });
    return r.outputLines >= 100 ? r : null;
  });
  assert.ok(read, "the producer finished");
  assert.ok(read.bufferedBytes <= 4096 + 501, `held ${read.bufferedBytes} bytes against a 4096 cap`);
  assert.ok(read.droppedLines > 0, "which it could only do by dropping lines");
});

test("a line with no trailing newline still becomes readable once the process ends", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "printf 'no-newline-here'", sandbox: false });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const read = await until(() => {
    const r = m.read(id);
    return r.lines.includes("no-newline-here") ? r : null;
  });
  assert.ok(read, "the half-line was flushed on stream close rather than swallowed");
});

test("stop terminates the shell AND the children it started", { skip: !POSIX }, async () => {
  const dir = tempDir("pm-tree-");
  const pidFile = join(dir, "child.pid");
  const m = manager();
  // The `sleep` is a separate process; a naive child.kill() would take out the
  // `sh` wrapper and leave this one running and unowned.
  const { id } = m.start({
    command: `sleep 30 & echo $! > '${pidFile}'; wait`,
    sandbox: false,
  });

  const childPid = await until(() => {
    try { return Number(readFileSync(pidFile, "utf8").trim()) || null; } catch { return null; }
  });
  assert.ok(childPid, "the grandchild reported its pid");
  assert.doesNotThrow(() => process.kill(childPid, 0), "grandchild is alive before stop");

  const stopped = await m.stop(id, { graceMs: 1000 });
  assert.equal(stopped.ok, true);
  assert.notEqual(stopped.process.status, "running");

  const gone = await until(() => {
    try { process.kill(childPid, 0); return false; } catch { return true; }
  }, { timeoutMs: 5000 });
  assert.ok(gone, `grandchild pid ${childPid} survived stop() — the process group was not signalled`);
});

test("stop escalates to a forceful kill when the process ignores the polite signal", { skip: !POSIX }, async () => {
  const m = manager();
  // The trap makes the shell ignore SIGTERM, and the loop restarts the `sleep`
  // that the group signal does manage to kill — so only SIGKILL ends this.
  const { id } = m.start({ command: "trap '' TERM; echo armed; while :; do sleep 0.05; done", sandbox: false });
  // Wait for the marker, not just for status: signalling before the shell has
  // installed the trap would test nothing.
  assert.ok(await until(() => m.read(id).lines.includes("armed")), "the trap is installed");

  const stopped = await m.stop(id, { graceMs: 300 });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.forced, true, "SIGTERM was ignored, so SIGKILL had to follow");
  assert.equal(stopped.process.status, "killed");
  assert.equal(stopped.process.signal, "SIGKILL");
});

test("stopping an already-exited process is a no-op rather than an error", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "echo done", sandbox: false });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const stopped = await m.stop(id);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.alreadyExited, true);
});

test("stopAll terminates every running process at once", { skip: !POSIX }, async () => {
  const m = manager();
  const ids = [1, 2, 3].map(() => m.start({ command: "sleep 30", sandbox: false }).id);
  await until(() => m.list({ includeExited: false }).length === 3);

  const results = await m.stopAll({ graceMs: 1000 });
  assert.equal(results.length, 3);
  assert.equal(m.list({ includeExited: false }).length, 0, "nothing is left running");
  for (const id of ids) assert.notEqual(m.status(id).status, "running");
});

test("list reports id, command, status, exit code, uptime and output size", { skip: !POSIX }, async () => {
  const m = manager();
  const alive = m.start({ command: "sleep 30", sandbox: false });
  const done = m.start({ command: "echo bye; exit 3", sandbox: false });
  await m.waitForExit(done.id, { timeoutMs: 5000 });

  const rows = await until(() => {
    const all = m.list();
    return all.find((r) => r.id === done.id)?.outputBytes > 0 ? all : null;
  });
  assert.ok(rows, "the exited process reported its output size");
  assert.equal(rows.length, 2);
  const running = rows.find((r) => r.id === alive.id);
  const exited = rows.find((r) => r.id === done.id);
  assert.equal(running.status, "running");
  assert.equal(running.command, "sleep 30");
  assert.equal(running.exitCode, null);
  assert.ok(running.uptimeMs >= 0);
  assert.equal(exited.status, "exited");
  assert.equal(exited.exitCode, 3);
  assert.ok(exited.outputBytes >= 3, "output size is visible without reading the output");

  assert.deepEqual(m.list({ includeExited: false }).map((r) => r.id), [alive.id]);
});

test("output stays readable after the process has exited", { skip: !POSIX }, async () => {
  const m = manager({ retentionMs: 60_000 });
  const { id } = m.start({ command: "echo 'fatal: missing config' >&2; exit 1", sandbox: false });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const read = await until(() => {
    const r = m.read(id);
    return r.lines.some((l) => l.includes("fatal: missing config")) ? r : null;
  });
  assert.ok(read, "the reason it died survives the process");
  assert.equal(read.running, false);
  assert.equal(read.exitCode, 1);
});

test("exited processes are reaped once their retention window passes, running ones never", { skip: !POSIX }, async () => {
  let clock = 1_000_000;
  const m = manager({ retentionMs: 30_000, now: () => clock });
  const done = m.start({ command: "echo x", sandbox: false });
  const alive = m.start({ command: "sleep 30", sandbox: false });
  await m.waitForExit(done.id, { timeoutMs: 5000 });

  assert.ok(m.status(done.id), "still readable inside the window");
  clock += 29_000;
  assert.ok(m.status(done.id), "still readable one second before the window closes");

  clock += 2000;
  assert.equal(m.status(done.id), null, "reaped once it aged out");
  assert.equal(m.read(done.id).ok, false, "and read explains that it was cleaned up");
  assert.equal(m.status(alive.id).status, "running", "a live process is never reaped");
});

test("cleanup with force drops exited entries immediately and leaves running ones alone", { skip: !POSIX }, async () => {
  const m = manager({ retentionMs: 60_000 });
  const done = m.start({ command: "echo x", sandbox: false });
  const alive = m.start({ command: "sleep 30", sandbox: false });
  await m.waitForExit(done.id, { timeoutMs: 5000 });

  const removed = m.cleanup({ force: true });
  assert.deepEqual(removed, [done.id]);
  assert.equal(m.status(done.id), null);
  assert.equal(m.status(alive.id).status, "running");
});

test("the retained-corpse table is capped even inside the retention window", { skip: !POSIX }, async () => {
  const m = manager({ retentionMs: 60_000, maxRetained: 3 });
  for (let i = 0; i < 6; i += 1) {
    const { id } = m.start({ command: `echo ${i}`, sandbox: false });
    await m.waitForExit(id, { timeoutMs: 5000 });
  }
  assert.equal(m.list().length, 3, "oldest corpses give way rather than growing without bound");
  assert.deepEqual(m.list().map((r) => r.command), ["echo 3", "echo 4", "echo 5"]);
});

test("commands go through the sandbox wrapper in the same shape the bash tool uses", { skip: !POSIX }, async () => {
  const dir = tempDir("pm-sandbox-");
  const bin = join(dir, "echo-argv-sandbox");
  writeFileSync(bin, '#!/bin/sh\nprintf "ARGV:%s\\n" "$*"\n');
  chmodSync(bin, 0o755);

  const m = manager({ sandboxBin: bin });
  const { id } = m.start({ command: "echo hi" });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const read = await until(() => {
    const r = m.read(id);
    return r.lines.some((l) => l.startsWith("ARGV:")) ? r : null;
  });
  assert.ok(read, "the sandbox binary was the thing actually launched");
  assert.equal(read.lines[0], "ARGV:sandbox -- sh -c echo hi");
});

test("a sandboxed command still runs and its output is captured", { skip: !POSIX }, async () => {
  const dir = tempDir("pm-sandbox-run-");
  const m = manager({ sandboxBin: passthroughSandbox(dir) });
  const { id } = m.start({ command: "echo through-the-sandbox" });
  await m.waitForExit(id, { timeoutMs: 5000 });

  const read = await until(() => {
    const r = m.read(id);
    return r.lines.includes("through-the-sandbox") ? r : null;
  });
  assert.ok(read, "the wrapped command ran");
});

test("a sandbox binary that cannot be launched is recorded as failed, not thrown", { skip: !POSIX }, async () => {
  const m = manager({ sandboxBin: join(tempDir("pm-missing-"), "definitely-not-here") });
  const { id } = m.start({ command: "echo hi" });

  const exit = await m.waitForExit(id, { timeoutMs: 5000 });
  assert.ok(exit, "the failure settles the handle instead of hanging");
  assert.equal(exit.status, "failed");
  assert.match(String(exit.error), /ENOENT|spawn/i);
  const read = m.read(id);
  assert.match(read.text, /ENOENT/, "the reason is in the output the agent will read");
});

test("start refuses an empty command and refuses to exceed the running cap", { skip: !POSIX }, async () => {
  const m = manager({ maxRunning: 2 });
  assert.equal(m.start({ command: "   ", sandbox: false }).ok, false);

  const a = m.start({ command: "sleep 30", sandbox: false });
  const b = m.start({ command: "sleep 30", sandbox: false });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const third = m.start({ command: "sleep 30", sandbox: false });
  assert.equal(third.ok, false);
  assert.match(third.error, /too many background processes/);
  assert.match(third.error, new RegExp(a.id), "and names the handles that are in the way");

  // Freeing a slot makes room again, so the cap is a live count, not a total.
  await m.stop(a.id, { graceMs: 500 });
  assert.equal(m.start({ command: "sleep 30", sandbox: false }).ok, true);
});

test("reading or stopping an unknown handle fails cleanly", { skip: !POSIX }, async () => {
  const m = manager();
  assert.equal(m.status("bg_999"), null);
  assert.equal(m.read("bg_999").ok, false);
  assert.match(m.read("bg_999").error, /unknown process/);
  assert.equal((await m.stop("bg_999")).ok, false);
  assert.equal(await m.waitForExit("bg_999", { timeoutMs: 10 }), null);
});

test("waitForExit returns null rather than throwing while the process is still running", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "sleep 30", sandbox: false });
  assert.equal(await m.waitForExit(id, { timeoutMs: 150 }), null);
  assert.equal(m.status(id).status, "running", "and the process is untouched by the timeout");
});

test("dispose stops everything and refuses further starts", { skip: !POSIX }, async () => {
  const m = manager();
  const { id } = m.start({ command: "sleep 30", sandbox: false });
  const pid = m.status(id).pid;

  await m.dispose({ graceMs: 1000 });
  const gone = await until(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { timeoutMs: 5000 });
  assert.ok(gone, "the tree is dead after dispose");
  assert.equal(m.list().length, 0, "and the table is emptied");
  assert.equal(m.start({ command: "echo hi", sandbox: false }).ok, false);
});

test("two managers never see each other's processes", { skip: !POSIX }, async () => {
  const a = manager();
  const b = manager();
  const started = a.start({ command: "sleep 30", sandbox: false });

  assert.equal(b.list().length, 0);
  assert.equal(b.status(started.id), null, "ids are scoped to the manager that issued them");
  assert.equal(a.list().length, 1);
});

test("the documented defaults are the ones actually applied", () => {
  assert.equal(DEFAULTS.maxLines, 2000);
  assert.ok(DEFAULTS.retentionMs > 0);
  assert.ok(DEFAULTS.killGraceMs > 0);
});
