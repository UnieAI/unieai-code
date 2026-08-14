// One policy decides where a write may land, whichever tool is asking.
//
// Before this, `bash` ran inside the platform sandbox and `write`/`edit` did
// not, so a session the client had labelled read-only could still rewrite the
// whole repo through the file tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createWritePolicy } from "./write-policy.mjs";

const ROOT = "/work/repo";
const policy = (opts) => createWritePolicy({ workspace: ROOT, ...opts });

test("an ordinary file in the workspace is allowed without a prompt", () => {
  assert.equal(policy().assess(join(ROOT, "src/main.py")).decision, "allow");
});

test("read-only means read-only for the file tools too", () => {
  const v = policy({ mode: "readOnly" }).assess(join(ROOT, "src/main.py"));
  assert.equal(v.decision, "ask");
  assert.equal(v.kind, "read_only_write");
});

test("a path outside the workspace is asked about, and says where it went", () => {
  const v = policy().assess("/etc/passwd");
  assert.equal(v.decision, "ask");
  assert.equal(v.kind, "external_directory");
  assert.match(v.reason, /outside the workspace root/);
});

test(".git is asked about even inside the workspace", () => {
  // Rewriting refs or installing a hook is indistinguishable from a normal edit
  // to every guard above this one.
  const v = policy().assess(join(ROOT, ".git/hooks/pre-commit"));
  assert.equal(v.decision, "ask");
  assert.equal(v.kind, "protected_path");
});

test("a file merely NAMED like .git is not protected", () => {
  assert.equal(policy().assess(join(ROOT, "gitignore-notes.md")).decision, "allow");
  assert.equal(policy().assess(join(ROOT, "src/.gitkeep")).decision, "allow");
});

test("extra writable roots are honoured, including outside the workspace", () => {
  const p = policy({ writableRoots: ["/tmp/build"] });
  assert.equal(p.assess("/tmp/build/out.o").decision, "allow");
  assert.equal(p.assess("/tmp/other/out.o").decision, "ask");
});

test("full access is exactly that, and read-only does not survive it", () => {
  assert.equal(policy({ mode: "danger-full-access" }).assess("/etc/passwd").decision, "allow");
});

test("an approved path stops being asked about", () => {
  const p = policy({ mode: "readOnly" });
  const target = join(ROOT, "notes.md");
  assert.equal(p.assess(target).decision, "ask");
  p.remember(target);
  assert.equal(p.assess(target).decision, "allow");
  // Only that path — approving one file is not approving the session.
  assert.equal(p.assess(join(ROOT, "other.md")).decision, "ask");
});

test("a traversal out of the workspace is caught as external, not as a relative path", () => {
  assert.equal(policy().assess(join(ROOT, "../../etc/passwd")).kind, "external_directory");
});

test("the workspace root itself is inside the workspace", () => {
  assert.equal(policy().assess(ROOT).decision, "allow");
});
