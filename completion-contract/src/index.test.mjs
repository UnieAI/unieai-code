// The contract decides whether a coding turn is allowed to end. Two properties
// matter more than anything else here:
//
//   · it blocks a turn that changed nothing — the mechanism that took a weak
//     model from 20% to 46% on SWE-bench Verified, by collapsing the
//     empty-handed rate from 71% to 13%;
//   · it fails OPEN everywhere else. Refusing to let a turn finish because our
//     verifier is broken is strictly worse than finishing unverified.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCompletionContract, NO_MUTATION_NUDGE } from "./index.mjs";

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const skip = gitAvailable ? false : "git unavailable";

/** A committed repo with one tracked file. */
function repo(content = "def f():\n    return 1\n") {
  const dir = mkdtempSync(join(tmpdir(), "contract-"));
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.py"), content, "utf8");
  git("add", "-A");
  git("commit", "-qm", "base");
  return dir;
}

const never = async () => { throw new Error("the skeptic should not have been called"); };

test("a turn that changed nothing is blocked", { skip }, async () => {
  const check = createCompletionContract({ workspace: repo(), callModel: never });
  assert.equal(await check({ task: "fix the bug" }), NO_MUTATION_NUDGE);
});

test("the nudge leaves an escape hatch, so a review-only task is not forced to edit", { skip }, () => {
  // The gate wants an account of why nothing changed, not an edit for its own
  // sake. Without this, "just tell me what you'd change" becomes unanswerable.
  assert.match(NO_MUTATION_NUDGE, /state explicitly why/);
});

test("a broken change is caught before any model is called", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def broken(\n", "utf8");
  const nudge = await createCompletionContract({ workspace: dir, callModel: never })({ task: "fix it" });
  assert.match(nudge, /fails to compile/);
  rmSync(dir, { recursive: true, force: true });
});

test("the deterministic gates run once, not every turn", { skip }, async () => {
  // Repeating them turns a nudge into nagging; the model has already seen them.
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def broken(\n", "utf8");
  const state = {};
  const check = createCompletionContract({ workspace: dir, callModel: async () => "ACHIEVED", state });
  assert.match(await check({ task: "t" }), /fails to compile/);
  assert.equal(await check({ task: "t" }), null, "the same complaint was sent twice");
  rmSync(dir, { recursive: true, force: true });
});

test("a clean change goes to the skeptic, with the task and the answer", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  let seen = null;
  const check = createCompletionContract({
    workspace: dir,
    callModel: async (p) => { seen = p; return "ACHIEVED"; },
  });
  assert.equal(await check({ task: "return 2 instead", answerText: "changed it", wasNudged: true }), null);
  assert.match(seen.user, /return 2 instead/);
  assert.match(seen.user, /changed it/);
  assert.match(seen.user, /Workspace diff/);
  rmSync(dir, { recursive: true, force: true });
});

test("gaps come back as a nudge", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const nudge = await createCompletionContract({
    workspace: dir,
    callModel: async () => "- the sibling path still returns 1",
  })({ task: "t", wasNudged: true });
  assert.match(nudge, /sibling path still returns 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("the same gaps twice in a row stop the nudging", { skip }, async () => {
  // Re-nudging on an unchanged blocker only spins. This is the stall exit, and
  // it depends on (previous, new) argument order — backwards, it never fires.
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const state = {};
  const gaps = "- the sibling path still returns 1";
  const once = async () => {
    state.skepticRan = false; // a fresh turn
    return createCompletionContract({ workspace: dir, callModel: async () => gaps, state })({ task: "t", wasNudged: true });
  };
  assert.ok(await once(), "the first round should nudge");
  assert.equal(await once(), null, "the second identical round should let the turn end");
  rmSync(dir, { recursive: true, force: true });
});

test("escalation climbs while the gaps keep changing", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const state = {};
  const round = async (gaps) => {
    state.skepticRan = false;
    return createCompletionContract({ workspace: dir, callModel: async () => gaps, state })({ task: "t", wasNudged: true });
  };
  await round("- gap one");
  await round("- gap two");
  const third = await round("- gap three");
  assert.equal(state.consecutiveNotAchieved, 3);
  assert.match(third, /reconsider|whole approach|failed review/i, "the ladder never reached the strategist rung");
  rmSync(dir, { recursive: true, force: true });
});

// ── failing open ─────────────────────────────────────────────────────────────

test("a directory that is not a git repo lets the turn end", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "contract-nogit-"));
  assert.equal(await createCompletionContract({ workspace: dir, callModel: never })({ task: "t" }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a skeptic that throws lets the turn end", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const check = createCompletionContract({
    workspace: dir,
    callModel: async () => { throw new Error("gateway down"); },
  });
  assert.equal(await check({ task: "t" }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("a skeptic that answers nothing lets the turn end", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const check = createCompletionContract({ workspace: dir, callModel: async () => "" });
  assert.equal(await check({ task: "t" }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("an untracked-only turn is still reviewed", { skip }, async () => {
  // `git diff` shows tracked edits only, so a turn whose whole output was a new
  // repro script used to pass the mutation gate and skip the skeptic entirely.
  const dir = repo();
  writeFileSync(join(dir, "repro.py"), "print('repro')\n", "utf8");
  let seen = null;
  await createCompletionContract({
    workspace: dir,
    callModel: async (p) => { seen = p; return "ACHIEVED"; },
  })({ task: "t", wasNudged: true });
  assert.ok(seen, "the skeptic never ran for an untracked-only change");
  assert.match(seen.user, /repro\.py/);
  rmSync(dir, { recursive: true, force: true });
});

// ── the adaptive skeptic ─────────────────────────────────────────────────────
// Measured: the review is worth +8 on a model that stops empty-handed 71% of the
// time and −3 on one that does so 1% of the time. "nudged" spends it only where
// it pays.

test("a turn that acted unprompted is not reviewed", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const state = {};
  const nudge = await createCompletionContract({ workspace: dir, callModel: never, state })({
    task: "t",
    wasNudged: false,
  });
  assert.equal(nudge, null);
  assert.equal(state.skepticSkipped, true, "skipped must be distinguishable from found-nothing");
  assert.notEqual(state.skepticRan, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a turn that had to be pushed IS reviewed", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  let ran = false;
  const nudge = await createCompletionContract({
    workspace: dir,
    callModel: async () => { ran = true; return "- still wrong"; },
  })({ task: "t", wasNudged: true });
  assert.equal(ran, true);
  assert.match(nudge, /still wrong/);
  rmSync(dir, { recursive: true, force: true });
});

test("a turn the deterministic gates flagged is reviewed even if never nudged", { skip }, async () => {
  // The gates finding a compile error is itself evidence the turn needs looking
  // at, whether or not the mutation gate ever fired.
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def broken(\n", "utf8");
  const state = {};
  const check = createCompletionContract({ workspace: dir, callModel: async () => "- gap", state });
  await check({ task: "t", wasNudged: false });        // gates fire
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8"); // model fixes it
  const second = await check({ task: "t", wasNudged: false });
  assert.match(second ?? "", /gap/, "a turn with a flagged history skipped its review");
  rmSync(dir, { recursive: true, force: true });
});

test("always and never mean what they say", { skip }, async () => {
  const dir = repo();
  writeFileSync(join(dir, "a.py"), "def f():\n    return 2\n", "utf8");
  const always = await createCompletionContract({
    workspace: dir, skepticMode: "always", callModel: async () => "- gap",
  })({ task: "t", wasNudged: false });
  assert.match(always, /gap/);

  const nope = await createCompletionContract({
    workspace: dir, skepticMode: "never", callModel: never,
  })({ task: "t", wasNudged: true });
  assert.equal(nope, null);
  rmSync(dir, { recursive: true, force: true });
});
