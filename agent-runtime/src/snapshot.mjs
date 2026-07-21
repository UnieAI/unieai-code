/**
 * snapshot.mjs — workspace checkpoints in a SHADOW git repo (idea from opencode's
 * snapshot service). Each checkpoint is a git tree hash written to a git dir that
 * is completely separate from the user's own `.git`, so the user's history,
 * index, and branches are never touched.
 *
 * This module owns the SAFE, read-only-ish half: init the shadow repo, take a
 * checkpoint (tree hash), diff two checkpoints, and read a file's content at a
 * checkpoint (for preview). The DESTRUCTIVE apply (restoring files over the live
 * workspace) is deliberately NOT here — it belongs with the three-phase
 * stage/clear/commit preview UI (see the tui-rewind-diff change), so a revert is
 * never applied without the user seeing exactly what it will overwrite.
 *
 * All git calls target the shadow dir via GIT_DIR/GIT_WORK_TREE and disable
 * global/system config so a user's git settings can't perturb them. Best-effort:
 * every function fails soft (null / empty) rather than throwing.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Always excluded from snapshots, on top of the workspace's own .gitignore —
// a workspace WITHOUT a .gitignore would otherwise snapshot node_modules or
// build trees wholesale and blow up the shadow repo.
const DEFAULT_EXCLUDES = [
  "node_modules/",
  "target/",
  "dist/",
  "build/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  ".cache/",
  "*.log",
];

function git(shadowDir, workspace, args) {
  return spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_DIR: shadowDir,
      GIT_WORK_TREE: workspace,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/** Initialize the shadow repo (idempotent). Returns true on success. */
export function initShadow(shadowDir, workspace) {
  try {
    mkdirSync(shadowDir, { recursive: true });
    const r = git(shadowDir, workspace, ["init", "-q"]);
    if (r.status !== 0) return false;
    // Shadow-repo-local excludes (git reads $GIT_DIR/info/exclude in addition to
    // the workspace's .gitignore) — never touches any file in the workspace.
    mkdirSync(join(shadowDir, "info"), { recursive: true });
    writeFileSync(join(shadowDir, "info", "exclude"), DEFAULT_EXCLUDES.join("\n") + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a checkpoint: stage the whole work-tree (honoring the workspace's own
 * .gitignore) and write a tree object. Returns the tree hash, or null on failure.
 * Writes only to the shadow dir — the workspace files are untouched.
 */
export function snapshotWorkspace(shadowDir, workspace) {
  try {
    const add = git(shadowDir, workspace, ["add", "-A"]);
    if (add.status !== 0) return null;
    const wt = git(shadowDir, workspace, ["write-tree"]);
    if (wt.status !== 0) return null;
    const tree = wt.stdout.trim();
    return tree || null;
  } catch {
    return null;
  }
}

/**
 * List paths that differ between two checkpoints (tree hashes). Returns
 * [{ path, status }] where status is git's A/M/D. Read-only.
 */
export function listChangedPaths(shadowDir, workspace, treeA, treeB) {
  try {
    const r = git(shadowDir, workspace, ["diff-tree", "-r", "--name-status", "--no-renames", treeA, treeB]);
    if (r.status !== 0) return [];
    return r.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        return { status: status[0], path: rest.join(" ") };
      });
  } catch {
    return [];
  }
}

/** Read a file's content at a checkpoint (for preview/diff). null if absent. */
export function readFileAt(shadowDir, workspace, tree, path) {
  try {
    const r = git(shadowDir, workspace, ["cat-file", "-p", `${tree}:${path}`]);
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
