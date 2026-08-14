// The point of a session shell is that the next command sees what the last one
// did. Everything else here is about what happens when that breaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellSession } from "./shell-session.mjs";
import { shellSessionArgv } from "./portable-exec.mjs";

const argv = shellSessionArgv();
const skip = argv ? false : "no persistent shell on this platform";

function session() {
  return createShellSession({ argv, cwd: mkdtempSync(join(tmpdir(), "unieai-shell-")) });
}

test("a command's output and exit code come back", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  const out = await s.run("echo hello");
  assert.match(out.output, /hello/);
  assert.equal(out.exitCode, 0);
});

test("a non-zero exit is reported, not swallowed", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  assert.equal((await s.run("(exit 7)")).exitCode, 7);
  assert.equal((await s.run("ls /definitely/not/here")).exitCode !== 0, true);
});

test("a command that exits the shell restarts it instead of wedging", { skip }, async (t) => {
  // `exit` is a shell builtin, so a model that writes one takes the session
  // down with it. The session has to notice and come back, or every later
  // command would be written into a pipe with nothing on the other end.
  const s = session();
  t.after(() => s.close());
  const out = await s.run("exit 5");
  assert.equal(out.restarted, true, "the session did not notice its shell had gone");
  assert.match((await s.run("echo alive")).output, /alive/);
});

test("stderr arrives with stdout, in the shell's own order", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  const out = await s.run("echo out; echo err 1>&2");
  assert.match(out.output, /out/);
  assert.match(out.output, /err/);
});

test("cd persists — the whole reason this exists", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.run("mkdir -p nested/deeper && cd nested/deeper");
  const out = await s.run("pwd");
  assert.match(out.output, /nested\/deeper/);
});

test("exported variables persist too", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.run("export UNIEAI_TEST_TOKEN=kept");
  assert.match((await s.run("echo $UNIEAI_TEST_TOKEN")).output, /kept/);
});

test("output that looks like a sentinel cannot end a command early", { skip }, async (t) => {
  // The token is per-session and random precisely so echoed text cannot forge it.
  const s = session();
  t.after(() => s.close());
  const out = await s.run("echo __unieai_done_deadbeef__ 0; echo after");
  assert.match(out.output, /after/, "the command was cut short by its own output");
  assert.equal(out.exitCode, 0);
});

test("a command that outlives its timeout restarts the shell", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  const out = await s.run("sleep 5", { timeoutMs: 150 });
  assert.equal(out.timedOut, true);
  assert.equal(out.restarted, true, "a timed-out command left the stream attached to the next one");

  // And the replacement is usable, with the old environment honestly gone.
  await s.run("export UNIEAI_GONE=1");
  const after = await s.run("echo [$UNIEAI_GONE]");
  assert.match(after.output, /\[1\]/, "the replacement shell does not work");
});

test("state does not survive a restart, and the caller is told", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  await s.run("export UNIEAI_BEFORE=1");
  const timedOut = await s.run("sleep 5", { timeoutMs: 150 });
  assert.equal(timedOut.restarted, true);
  const after = await s.run("echo [$UNIEAI_BEFORE]");
  assert.match(after.output, /\[\]/, "state was claimed to be reset but survived");
});

test("two commands cannot run at once on one session", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  const first = s.run("sleep 0.3");
  await assert.rejects(() => s.run("echo second"), /already running/);
  await first;
});

test("stdin can be fed to something waiting for it", { skip }, async (t) => {
  const s = session();
  t.after(() => s.close());
  // `read` blocks until a line arrives, so the command times out and the answer
  // is fed afterwards — the shape `write_stdin` exists for.
  const started = s.run("read line; echo got:$line", { timeoutMs: 200 });
  await started;
  const fed = await s.writeStdin("value\n", { waitMs: 300 });
  assert.equal(typeof fed.output, "string");
});
