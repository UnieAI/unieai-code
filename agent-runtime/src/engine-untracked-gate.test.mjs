// `git status` counts untracked files; `git diff` does not. That gap let a turn
// whose only output was a scratch repro script pass the mutation gate (status was
// dirty) and then skip the skeptic entirely (diff was empty) — "wrote a file,
// changed nothing" ended turns unchallenged. The digest closes it by showing new
// files to the verifier alongside the diff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untrackedDigest } from "./engine.mjs";

function tmpWs() {
  return mkdtempSync(join(tmpdir(), "untracked-gate-"));
}

test("no untracked entries yields nothing to append", () => {
  const dir = tmpWs();
  try {
    assert.equal(untrackedDigest(dir, " M src/a.py\nA  src/b.py\n"), "");
    assert.equal(untrackedDigest(dir, ""), "");
    assert.equal(untrackedDigest(dir, null), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an untracked file's name and opening lines reach the verifier", () => {
  const dir = tmpWs();
  try {
    writeFileSync(join(dir, "repro.py"), "import django\nprint('boom')\n");
    const out = untrackedDigest(dir, "?? repro.py\n");
    assert.match(out, /## New \(untracked\) files/);
    assert.match(out, /### repro\.py/);
    assert.match(out, /print\('boom'\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("quoted paths and mixed status lines are handled", () => {
  const dir = tmpWs();
  try {
    writeFileSync(join(dir, "has space.py"), "x = 1\n");
    const out = untrackedDigest(dir, ' M src/a.py\n?? "has space.py"\n');
    assert.match(out, /### has space\.py/);
    assert.match(out, /x = 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the digest is capped so a vendored tree cannot flood the prompt", () => {
  const dir = tmpWs();
  try {
    const porcelain = Array.from({ length: 9 }, (_, i) => {
      writeFileSync(join(dir, `f${i}.py`), `# file ${i}\n`);
      return `?? f${i}.py`;
    }).join("\n");
    const out = untrackedDigest(dir, porcelain);
    assert.match(out, /### f0\.py/);
    assert.ok(!out.includes("### f5.py"));
    assert.match(out, /\+4 more untracked paths/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an untracked directory is skipped without throwing", () => {
  const dir = tmpWs();
  try {
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "ok.py"), "y = 2\n");
    const out = untrackedDigest(dir, "?? build/\n?? ok.py\n");
    assert.match(out, /### ok\.py/);
    assert.match(out, /y = 2/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
