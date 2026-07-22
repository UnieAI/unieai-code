import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initShadow, snapshotWorkspace, listChangedPaths, readFileAt } from "./snapshot.mjs";

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

test("shadow snapshot captures, diffs, and reads without touching the user's .git", { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), "snap-"));
  const workspace = join(root, "ws");
  const shadow = join(root, "shadow.git");
  mkdirSync(workspace, { recursive: true });

  // A real user .git we must never disturb.
  spawnSync("git", ["init", "-q"], { cwd: workspace });
  writeFileSync(join(workspace, "a.txt"), "hello\n");
  writeFileSync(join(workspace, ".gitignore"), "ignored/\n");
  mkdirSync(join(workspace, "ignored"), { recursive: true });
  writeFileSync(join(workspace, "ignored", "big.bin"), "x".repeat(1000));

  try {
    assert.equal(initShadow(shadow, workspace), true);
    const t1 = snapshotWorkspace(shadow, workspace);
    assert.ok(t1 && /^[0-9a-f]{40}$/.test(t1), "checkpoint 1 is a tree hash");

    // Change a.txt and add b.txt, then snapshot again.
    writeFileSync(join(workspace, "a.txt"), "hello world\n");
    writeFileSync(join(workspace, "b.txt"), "new file\n");
    const t2 = snapshotWorkspace(shadow, workspace);
    assert.ok(t2 && t2 !== t1, "checkpoint 2 differs");

    const changed = listChangedPaths(shadow, workspace, t1, t2);
    const byPath = Object.fromEntries(changed.map((c) => [c.path, c.status]));
    assert.equal(byPath["a.txt"], "M");
    assert.equal(byPath["b.txt"], "A");
    assert.ok(!("ignored/big.bin" in byPath), ".gitignore honored — ignored dir not snapshotted");

    // Read the OLD content of a.txt at checkpoint 1 (preview).
    assert.equal(readFileAt(shadow, workspace, t1, "a.txt"), "hello\n");
    assert.equal(readFileAt(shadow, workspace, t1, "b.txt"), null, "b.txt absent at t1");

    // The user's real workspace file is unchanged by any of this.
    const live = spawnSync("git", ["status", "--porcelain"], { cwd: workspace, encoding: "utf8" });
    assert.match(live.stdout, /a\.txt/, "user's own git still sees its own working changes, untouched by shadow ops");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default excludes protect a workspace WITHOUT .gitignore from snapshot blowup", { skip: !gitAvailable }, () => {
  const root = mkdtempSync(join(tmpdir(), "snap-noignore-"));
  const workspace = join(root, "ws");
  const shadow = join(root, "shadow.git");
  mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(workspace, "node_modules", "pkg", "index.js"), "x".repeat(5000));
  writeFileSync(join(workspace, "app.js"), "console.log(1)\n");

  try {
    assert.equal(initShadow(shadow, workspace), true);
    const t1 = snapshotWorkspace(shadow, workspace);
    assert.ok(t1, "snapshot succeeds");
    // Diff the empty tree → t1 to enumerate everything captured.
    const emptyTree = spawnSync("git", ["hash-object", "-t", "tree", "/dev/null"], { encoding: "utf8" }).stdout.trim();
    const captured = listChangedPaths(shadow, workspace, emptyTree, t1).map((c) => c.path);
    assert.ok(captured.includes("app.js"), "real source captured");
    assert.ok(!captured.some((p) => p.startsWith("node_modules/")), "node_modules excluded by default excludes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoreToTree round-trips: modify+add+delete, restore, then undo forward", { skip: !gitAvailable }, async () => {
  const { previewRestore, restoreToTree } = await import("./snapshot.mjs");
  const { readFileSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "snap-restore-"));
  const workspace = join(root, "ws");
  const shadow = join(root, "shadow.git");
  mkdirSync(workspace, { recursive: true });
  try {
    assert.equal(initShadow(shadow, workspace), true);
    writeFileSync(join(workspace, "keep.txt"), "unchanged\n");
    writeFileSync(join(workspace, "mod.txt"), "v1\n");
    writeFileSync(join(workspace, "gone.txt"), "will be deleted\n");
    const t1 = snapshotWorkspace(shadow, workspace);
    assert.ok(t1);

    // mutate: modify, add, delete
    writeFileSync(join(workspace, "mod.txt"), "v2\n");
    writeFileSync(join(workspace, "new.txt"), "brand new\n");
    rmSync(join(workspace, "gone.txt"));

    // preview lists exactly the three differing paths, touches nothing
    const p = previewRestore(shadow, workspace, t1);
    assert.ok(p && p.current);
    assert.deepEqual(p.files.map((f) => f.path).sort(), ["gone.txt", "mod.txt", "new.txt"]);
    assert.equal(readFileSync(join(workspace, "mod.txt"), "utf8"), "v2\n", "preview must not modify");

    // destructive restore back to t1
    const r = restoreToTree(shadow, workspace, t1);
    assert.ok(r);
    assert.equal(readFileSync(join(workspace, "mod.txt"), "utf8"), "v1\n");
    assert.equal(readFileSync(join(workspace, "gone.txt"), "utf8"), "will be deleted\n");
    assert.equal(existsSync(join(workspace, "new.txt")), false, "added file removed");
    assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "unchanged\n");

    // the undo point restores the mutated state right back
    const undo = restoreToTree(shadow, workspace, r.undoTree);
    assert.ok(undo);
    assert.equal(readFileSync(join(workspace, "mod.txt"), "utf8"), "v2\n");
    assert.equal(existsSync(join(workspace, "gone.txt")), false);
    assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "brand new\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
