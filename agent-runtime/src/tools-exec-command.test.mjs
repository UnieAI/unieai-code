// exec_command mounted as a tool: the state one call sets up is there for the
// next, and the tool is simply absent where no persistent shell exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";
import { shellSessionArgv } from "./portable-exec.mjs";

const skip = shellSessionArgv() ? false : "no persistent shell on this platform";

/** A backend whose session shell is a plain `sh`, so no sandbox binary is needed. */
const plainShell = {
  kind: "test",
  argv: (cmd) => ["sh", "-c", cmd],
  escalatedArgv: (cmd) => ["sh", "-c", cmd],
  sessionArgv: () => ["sh"],
  describe: () => "test shell",
};

async function toolsWith(backend) {
  const workspace = mkdtempSync(join(tmpdir(), "unieai-exec-cmd-"));
  const build = buildCodingTools({ workspace, execBackend: backend });
  return { ...(await build({})), workspace };
}

test("exec_command and write_stdin are mounted when a session shell exists", { skip }, async () => {
  const t = await toolsWith(plainShell);
  const names = t.schemas.map((s) => s.function.name);
  assert.ok(names.includes("exec_command"), "exec_command is missing");
  assert.ok(names.includes("write_stdin"), "write_stdin is missing");
});

test("they are absent when the backend has no session — not mounted and broken", { skip: false }, async () => {
  // `docker exec` is the real case: it starts a fresh process per call, so a
  // tool promising persistence would be promising something it cannot do.
  const t = await toolsWith({ ...plainShell, sessionArgv: () => null });
  const names = t.schemas.map((s) => s.function.name);
  assert.ok(!names.includes("exec_command"));
  assert.ok(!names.includes("write_stdin"));
  assert.ok(names.includes("bash"), "the one-shot shell should still be there");
});

test("the working directory set by one call is still set for the next", { skip }, async () => {
  const t = await toolsWith(plainShell);
  await t.executors.exec_command({ cmd: "mkdir -p pkg/inner && cd pkg/inner" });
  const out = await t.executors.exec_command({ cmd: "pwd" });
  assert.match(out.modelText, /pkg\/inner/);
  assert.equal(out.ok, true);
});

test("bash, by contrast, forgets — which is why this tool exists", { skip }, async () => {
  const t = await toolsWith(plainShell);
  await t.executors.bash({ cmd: "mkdir -p pkg/inner && cd pkg/inner" });
  const out = await t.executors.bash({ cmd: "pwd" });
  assert.doesNotMatch(out.modelText, /pkg\/inner/);
});

test("a failing command reports its exit code rather than looking successful", { skip }, async () => {
  const t = await toolsWith(plainShell);
  const out = await t.executors.exec_command({ cmd: "(exit 4)" });
  assert.equal(out.ok, false);
  assert.match(out.modelText, /exit 4/);
});

test("a timeout says the shell was reset, not just that it was slow", { skip }, async () => {
  const t = await toolsWith(plainShell);
  await t.executors.exec_command({ cmd: "export KEEP=1" });
  const out = await t.executors.exec_command({ cmd: "sleep 5", timeoutMs: 150 });
  assert.equal(out.ok, false);
  assert.match(out.modelText, /timed out/);
  assert.match(out.modelText, /restarted/, "the model was not told its environment is gone");
  // And the claim is true.
  const after = await t.executors.exec_command({ cmd: "echo [$KEEP]" });
  assert.match(after.modelText, /\[\]/);
});

test("an empty command is refused before a shell is touched", { skip }, async () => {
  const t = await toolsWith(plainShell);
  assert.equal((await t.executors.exec_command({ cmd: "   " })).ok, false);
  assert.equal((await t.executors.write_stdin({ text: "" })).ok, false);
});
