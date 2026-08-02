import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./tools.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds or the budget runs out; returns whether it held. */
async function until(check, budgetMs = 3000) {
  for (let waited = 0; waited < budgetMs; waited += 50) {
    if (await check()) return true;
    await wait(50);
  }
  return false;
}

test("a timed-out command takes its grandchildren with it", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-timeout-"));
  const pidFile = join(dir, "grandchild.pid");

  // A shell that starts a long sleeper and then waits on it. Node's own
  // `timeout` kills only the shell, leaving the sleeper running with nothing
  // left that knows about it.
  const finished = run("sh", ["-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`], {
    cwd: dir,
    timeoutMs: 300,
  });

  const recorded = await until(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim());
  assert.ok(recorded, "the fixture never recorded a grandchild pid");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `unusable pid: ${pid}`);

  await finished;
  assert.ok(await until(async () => !alive(pid)), "the grandchild outlived the timeout");
});

test("a command that finishes in time is unaffected by the timeout path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-timeout-ok-"));
  const result = await run("sh", ["-c", "echo hello"], { cwd: dir, timeoutMs: 10_000 });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);
  assert.equal(result.spawnError, null);
});

test("a non-zero exit is still reported as an exit, not a spawn failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-timeout-fail-"));
  const result = await run("sh", ["-c", "exit 3"], { cwd: dir, timeoutMs: 10_000 });
  assert.notEqual(result.code, 0);
  assert.equal(result.spawnError, null, "a command that ran must not look like a spawn failure");
});

test("a missing binary is still distinguished as a spawn failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-timeout-enoent-"));
  const result = await run("definitely-not-a-real-binary-xyz", [], { cwd: dir, timeoutMs: 5000 });
  assert.equal(result.spawnError, "ENOENT");
});

test("the timeout timer does not keep the process alive after a fast command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-timeout-unref-"));
  // A very long timeout on a command that returns immediately: if the timer
  // were neither cleared nor unref'd, the runtime would linger for its full
  // duration and every test run would hang.
  const result = await run("sh", ["-c", "true"], { cwd: dir, timeoutMs: 600_000 });
  assert.equal(result.code, 0);
});
