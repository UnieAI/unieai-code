import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedFilesFromStatus,
  buildSummaryRequest,
  clampSummary,
  SUMMARY_MAX_CHARS,
} from "./goal-summarizer.mjs";

test("changedFilesFromStatus parses porcelain paths", () => {
  const porcelain = " M src/engine.mjs\n?? src/new.mjs\nA  src/added.mjs\n";
  assert.deepEqual(changedFilesFromStatus(porcelain), ["src/engine.mjs", "src/new.mjs", "src/added.mjs"]);
});

test("changedFilesFromStatus takes the new path of a rename", () => {
  const porcelain = "R  src/old.mjs -> src/new.mjs\n";
  assert.deepEqual(changedFilesFromStatus(porcelain), ["src/new.mjs"]);
});

test("changedFilesFromStatus strips quotes and ignores blank lines", () => {
  const porcelain = ' M "src/has space.mjs"\n\n   \n';
  assert.deepEqual(changedFilesFromStatus(porcelain), ["src/has space.mjs"]);
});

test("changedFilesFromStatus is empty for empty input", () => {
  assert.deepEqual(changedFilesFromStatus(""), []);
  assert.deepEqual(changedFilesFromStatus(null), []);
});

test("buildSummaryRequest states the word/bullet cap and inlines files + diff", () => {
  const { system, user } = buildSummaryRequest({
    task: "add a guard",
    files: ["src/a.mjs", "src/b.mjs"],
    diff: "+ guard added",
  });
  assert.match(system, /80 words/);
  assert.match(system, /4 bullets/);
  assert.match(user, /src\/a\.mjs/);
  assert.match(user, /src\/b\.mjs/);
  assert.match(user, /guard added/);
  assert.match(user, /add a guard/);
});

test("buildSummaryRequest caps the diff and task sizes", () => {
  const { user } = buildSummaryRequest({
    task: "t".repeat(5000),
    files: [],
    diff: "d".repeat(50000),
    maxDiff: 100,
    maxTask: 50,
  });
  // Task capped at 50, diff capped at 100 (plus the surrounding template text).
  assert.ok(!user.includes("t".repeat(51)));
  assert.ok(!user.includes("d".repeat(101)));
  assert.match(user, /\(none reported\)/);
});

test("clampSummary trims and returns empty for blank input", () => {
  assert.equal(clampSummary("  hello world  "), "hello world");
  assert.equal(clampSummary(""), "");
  assert.equal(clampSummary("   \n "), "");
  assert.equal(clampSummary(null), "");
});

test("clampSummary clamps oversized output with a marker", () => {
  const long = "x".repeat(SUMMARY_MAX_CHARS + 200);
  const out = clampSummary(long);
  assert.ok(out.endsWith(" […]"));
  assert.equal(out.length, SUMMARY_MAX_CHARS + " […]".length);
});

test("clampSummary leaves compliant output unchanged", () => {
  const s = "Shipped X.\n- a\n- b";
  assert.equal(clampSummary(s), s);
  assert.ok(!clampSummary(s).includes("[…]"));
});
