import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "appr-"));
process.env.UNIEAI_HOME = home;
const { ruleSignature, loadApprovals, saveApproval } = await import("./approval-rules.mjs");

test("subcommand tools keep command + subcommand; flags/args dropped", () => {
  assert.equal(ruleSignature("git log -n5 --oneline"), "git log");
  assert.equal(ruleSignature("git log"), "git log");
  assert.equal(ruleSignature("npm install left-pad --save-dev"), "npm install");
  assert.equal(ruleSignature("cargo build --release"), "cargo build");
});

test("git log and git push get DIFFERENT signatures (no over-approval)", () => {
  assert.notEqual(ruleSignature("git log"), ruleSignature("git push origin main"));
});

test("plain commands reduce to the command name", () => {
  assert.equal(ruleSignature("ls -la /tmp"), "ls");
  assert.equal(ruleSignature("rg -n pattern src"), "rg");
});

test("commands with shell operators do not reduce (fail closed)", () => {
  assert.equal(ruleSignature("git log; rm -rf /"), "");
  assert.equal(ruleSignature("cat a | sh"), "");
  assert.equal(ruleSignature("echo $(whoami)"), "");
  assert.equal(ruleSignature(""), "");
});

test("save + load round-trips per project, arity-reduced rule matches variants", () => {
  const key = "/home/u/proj-a";
  assert.equal(loadApprovals(key).has("git log"), false);
  saveApproval(key, ruleSignature("git log -n5"));
  const set = loadApprovals(key);
  assert.equal(set.has("git log"), true);
  // a different flag variant maps to the same saved signature
  assert.equal(set.has(ruleSignature("git log --oneline --graph")), true);
});

test("approvals are isolated per project", () => {
  saveApproval("/home/u/proj-a", "npm install");
  assert.equal(loadApprovals("/home/u/proj-b").has("npm install"), false);
});

test("saving an empty signature is a no-op", () => {
  assert.equal(saveApproval("/home/u/proj-c", ""), false);
  assert.equal(loadApprovals("/home/u/proj-c").size, 0);
});

test.after(() => rmSync(home, { recursive: true, force: true }));

test("destructive commands never produce a rememberable signature", async () => {
  const { ruleSignature } = await import("./approval-rules.mjs");
  for (const cmd of ["rm tmp/x.txt", "rm -rf /", "find . -name '*.tmp' -delete", "chmod 777 x", "dd if=/dev/zero of=disk", "mv a b", "sudo ls", "sh -c 'anything'"]) {
    assert.equal(ruleSignature(cmd), "", `\`${cmd}\` must not reduce to a signature`);
  }
  // benign read-only commands still normalize
  assert.equal(ruleSignature("git log -n5 --oneline"), "git log");
  assert.equal(ruleSignature("ls -la"), "ls");
});
