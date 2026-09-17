// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closestWindow,
  findAllMatches,
  normalise,
  notFoundHint,
  planFuzzyEdit,
  seekSequence,
  stripReadLineNumbers,
  unifiedDiff,
} from "./unieai-edit-match.mjs";

// codex seek_sequence.rs tests
test("seekSequence: exact match", () => {
  assert.equal(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0), 1);
});

test("seekSequence: trailing whitespace ignored", () => {
  assert.equal(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0), 0);
});

test("seekSequence: surrounding whitespace ignored", () => {
  assert.equal(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0), 0);
});

test("seekSequence: pattern longer than input", () => {
  assert.equal(seekSequence(["just one line"], ["too", "many", "lines"], 0), -1);
});

test("seekSequence: unicode punctuation normalised", () => {
  assert.equal(seekSequence(["x = \u201chello\u201d \u2014 it\u2019s\u00a0ok"], ['x = "hello" - it\'s ok'], 0), 0);
  assert.equal(normalise("  a\u2013b  "), "a-b");
});

test("seekSequence: a stricter level anywhere wins over a looser earlier one", () => {
  assert.equal(seekSequence(["  foo", "foo"], ["foo"], 0), 1);
});

test("seekSequence: start and eof", () => {
  assert.equal(seekSequence(["a", "b", "a", "b"], ["a"], 1), 2);
  assert.equal(seekSequence(["a", "b", "a", "b"], ["a", "b"], 0, true), 2);
  assert.equal(seekSequence(["x"], [], 5), 5);
});

test("findAllMatches reports every match at the first matching level", () => {
  const r = findAllMatches(["  a", "a ", "b"], ["a"]);
  assert.deepEqual(r.indices, [1]);
  assert.equal(r.tierName, "ignoring trailing whitespace");
});

test("planFuzzyEdit: whitespace drift in old_string still applies", () => {
  const content = "def f():\n    x = 1   \n    return x\n";
  const plan = planFuzzyEdit(content, "def f():\n    x = 1\n", "def f():\n    x = 2\n");
  assert.equal(plan.ok, true);
  assert.equal(plan.content, "def f():\n    x = 2\n    return x\n");
  assert.equal(plan.tier, "ignoring trailing whitespace");
  assert.deepEqual(plan.lines, [1]);
});

test("planFuzzyEdit: wrong indentation is re-indented onto the file's", () => {
  const content = "class A:\n    def f(self):\n        return 1\n";
  const plan = planFuzzyEdit(content, "def f(self):\n    return 1", "def f(self):\n    return 2");
  assert.equal(plan.ok, true);
  assert.equal(plan.content, "class A:\n    def f(self):\n        return 2\n");
  assert.equal(plan.tier, "ignoring leading/trailing whitespace");
});

test("planFuzzyEdit: spaces written for a tab-indented file become tabs", () => {
  const content = "if x:\n\tprint('a')\n";
  const plan = planFuzzyEdit(content, "if x:\n    print('a')", "if x:\n    print('b')\n    if y:\n        z()");
  assert.equal(plan.ok, true);
  assert.equal(plan.content, "if x:\n\tprint('b')\n\tif y:\n\t\tz()\n");
});

test("planFuzzyEdit: read-tool line numbers are stripped", () => {
  const content = "a\nb\nc\n";
  const plan = planFuzzyEdit(content, "2: b\n3: c", "2: B\n3: c");
  assert.equal(plan.ok, true);
  assert.equal(plan.stripped, true);
  assert.equal(plan.content, "a\nB\nc\n");
});

test("stripReadLineNumbers only applies when every line has a prefix", () => {
  assert.equal(stripReadLineNumbers("12: x\n13: y"), "x\ny");
  assert.equal(stripReadLineNumbers("12: x\ny"), null);
});

test("planFuzzyEdit: unicode quotes in the file", () => {
  const content = "msg = \u201cdon\u2019t\u201d\n";
  const plan = planFuzzyEdit(content, `msg = "don't"`, `msg = "do"`);
  assert.equal(plan.ok, true);
  assert.equal(plan.content, 'msg = "do"\n');
});

test("planFuzzyEdit: ambiguous fuzzy match is refused without replace_all", () => {
  const content = "  x = 1\nfoo\n  x = 1\n";
  const plan = planFuzzyEdit(content, "x = 1", "x = 2");
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "ambiguous");
  assert.deepEqual(plan.lines, [1, 3]);
  const all = planFuzzyEdit(content, "x = 1", "x = 2", { replaceAll: true });
  assert.equal(all.ok, true);
  assert.equal(all.content, "  x = 2\nfoo\n  x = 2\n");
});

test("planFuzzyEdit: surrounding blank lines and trailing newline", () => {
  const content = "a\n    b\nc";
  const plan = planFuzzyEdit(content, "\n  b\n\n", "\n  B\n\n");
  assert.equal(plan.ok, true);
  assert.equal(plan.content, "a\n    B\nc");
});

test("planFuzzyEdit: deleting lines with an empty new_string", () => {
  const plan = planFuzzyEdit("a\n b \nc\n", "b\n", "");
  assert.equal(plan.ok, true);
  assert.equal(plan.content, "a\nc\n");
});

test("planFuzzyEdit: not found", () => {
  const plan = planFuzzyEdit("a\nb\n", "zzz", "y");
  assert.deepEqual(plan, { ok: false, reason: "not-found" });
});

test("closestWindow / notFoundHint point at the nearest lines", () => {
  const content = ["import os", "", "def compute(a, b):", "    total = a + b", "    return total", ""].join("\n");
  const w = closestWindow(content, "def compute(a, b):\n    total = a - b\n");
  assert.equal(w.start, 3);
  assert.equal(w.end, 4);
  assert.equal(w.firstDiff.line, 4);
  const hint = notFoundHint(content, "def compute(a, b):\n    total = a - b\n");
  assert.match(hint, /Closest match is lines 3-4/);
  assert.match(hint, /\s+4 {2}\s+total = a \+ b/);
  assert.match(hint, /First difference at line 4/);
  assert.match(notFoundHint("aaa\n", "zzzzzz qqqq"), /No similar lines/);
});

// codex file_update_tests.rs expectations (context radius 1)
test("unifiedDiff matches codex's hunks", () => {
  assert.equal(
    unifiedDiff("foo\nbar\nbaz\nqux\n", "foo\nBAR\nbaz\nQUX\n", { context: 1 }).text,
    "@@ -1,4 +1,4 @@\n foo\n-bar\n+BAR\n baz\n-qux\n+QUX",
  );
  assert.equal(unifiedDiff("foo\nbar\nbaz\n", "FOO\nbar\nbaz\n", { context: 1 }).text, "@@ -1,2 +1,2 @@\n-foo\n+FOO\n bar");
  assert.equal(unifiedDiff("foo\nbar\nbaz\n", "foo\nbar\nBAZ\n", { context: 1 }).text, "@@ -2,2 +2,2 @@\n bar\n-baz\n+BAZ");
  assert.equal(unifiedDiff("foo\nbar\nbaz\n", "foo\nbar\nbaz\nquux\n", { context: 1 }).text, "@@ -3 +3,2 @@\n baz\n+quux".replace("-3 ", "-3,1 "));
});

test("unifiedDiff: separate hunks, counts and truncation", () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n") + "\n";
  const b = a.replace("l2\n", "L2\n").replace("l25\n", "L25\nnew\n");
  const d = unifiedDiff(a, b);
  assert.equal(d.added, 3);
  assert.equal(d.removed, 2);
  assert.equal((d.text.match(/^@@/gm) ?? []).length, 2);
  assert.match(d.text, /^@@ -1,6 \+1,6 @@/);
  assert.match(d.text, /@@ -23,7 \+23,8 @@/);
  const cut = unifiedDiff(a, b, { maxLines: 4 });
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /more diff lines omitted/);
  assert.equal(unifiedDiff("x\n", "x\n").text, "");
  assert.equal(unifiedDiff("", "a\nb\n").text, "@@ -0,0 +1,2 @@\n+a\n+b");
});
