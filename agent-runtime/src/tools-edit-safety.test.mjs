import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodingTools,
  hashContent,
  hasBom,
  stripBom,
  detectNewline,
  encodeLike,
  isExternalPath,
} from "./tools.mjs";

// A sandbox binary is only needed by bash; these tests exercise read/write/edit
// which never launch it, so the default is fine. Each test that touches disk
// uses its own tmp workspace and cleans up.
function tmpWs() {
  return mkdtempSync(join(tmpdir(), "edit-safety-"));
}
async function tools(dir, opts = {}) {
  return buildCodingTools({ workspace: dir, ...opts })();
}

// --- 2.2 pure helpers --------------------------------------------------------

test("hasBom / stripBom detect and remove a leading BOM", () => {
  assert.equal(hasBom("﻿hello"), true);
  assert.equal(hasBom("hello"), false);
  assert.equal(stripBom("﻿hello"), "hello");
  assert.equal(stripBom("hello"), "hello"); // idempotent
});

test("detectNewline picks the dominant style", () => {
  assert.equal(detectNewline("a\nb\nc"), "\n");
  assert.equal(detectNewline("a\r\nb\r\nc"), "\r\n");
  assert.equal(detectNewline("no newlines here"), "\n");
  assert.equal(detectNewline("a\r\nb\r\nc\nd"), "\r\n"); // 2 CRLF vs 1 LF
  assert.equal(detectNewline("a\r\nb\nc\nd"), "\n"); // 1 CRLF vs 2 LF
});

test("encodeLike round-trips newline + BOM style", () => {
  assert.equal(encodeLike("a\nb", { bom: false, newline: "\n" }), "a\nb");
  assert.equal(encodeLike("a\nb", { bom: false, newline: "\r\n" }), "a\r\nb");
  assert.equal(encodeLike("a\nb", { bom: true, newline: "\r\n" }), "﻿a\r\nb");
  // Given CRLF-tainted input it still normalizes first, so no double \r.
  assert.equal(encodeLike("a\r\nb", { newline: "\r\n" }), "a\r\nb");
});

test("hashContent differs when bytes differ, matches when equal", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
});

// --- 2.3 isExternalPath ------------------------------------------------------

test("isExternalPath: inside / outside / .. escape / nested", () => {
  const ws = "/home/u/project";
  assert.equal(isExternalPath(ws, "src/a.js"), false); // nested relative
  assert.equal(isExternalPath(ws, "src/deep/nested/a.js"), false);
  assert.equal(isExternalPath(ws, "/home/u/project/x"), false); // absolute inside
  assert.equal(isExternalPath(ws, "/etc/passwd"), true); // absolute outside
  assert.equal(isExternalPath(ws, "../sibling/a.js"), true); // .. escape
  assert.equal(isExternalPath(ws, "../../a.js"), true);
  assert.equal(isExternalPath(ws, "."), false); // the root itself
  // A sibling dir with a shared prefix must NOT count as inside.
  assert.equal(isExternalPath(ws, "/home/u/project-evil/x"), true);
});

// --- 2.1 staleness guard (real handlers) ------------------------------------

test("edit refuses when the file changed on disk since the last read", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "a.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    await t.executors.read({ filePath: "a.txt" });
    // Something else rewrites the file after the model read it.
    writeFileSync(f, "one\nCHANGED\nthree\n");
    const r = await t.executors.edit({ filePath: "a.txt", oldString: "two", newString: "TWO" });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /changed on disk since you last read it/i);
    // File must be untouched by the refused edit.
    assert.equal(readFileSync(f, "utf8"), "one\nCHANGED\nthree\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit succeeds after a fresh read, and consecutive edits don't false-trigger", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "a.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    await t.executors.read({ filePath: "a.txt" });
    const r1 = await t.executors.edit({ filePath: "a.txt", oldString: "two", newString: "TWO" });
    assert.equal(r1.ok, true);
    // No re-read; the guard must have refreshed its snapshot to the written bytes.
    const r2 = await t.executors.edit({ filePath: "a.txt", oldString: "three", newString: "THREE" });
    assert.equal(r2.ok, true);
    assert.equal(readFileSync(f, "utf8"), "one\nTWO\nTHREE\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("edit without any prior read is allowed (no false staleness)", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "a.txt");
    writeFileSync(f, "hello world\n");
    const r = await t.executors.edit({ filePath: "a.txt", oldString: "world", newString: "there" });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(f, "utf8"), "hello there\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write over a stale file is refused", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "a.txt");
    writeFileSync(f, "original\n");
    await t.executors.read({ filePath: "a.txt" });
    writeFileSync(f, "changed underneath\n");
    const r = await t.executors.write({ filePath: "a.txt", content: "new body\n" });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /changed on disk/i);
    assert.equal(readFileSync(f, "utf8"), "changed underneath\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- 2.2 fidelity round-trip via real handlers ------------------------------

test("edit preserves CRLF + BOM (no phantom whole-file diff)", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "crlf.txt");
    // BOM + CRLF file.
    writeFileSync(f, "﻿alpha\r\nbeta\r\ngamma\r\n");
    await t.executors.read({ filePath: "crlf.txt" });
    const r = await t.executors.edit({ filePath: "crlf.txt", oldString: "beta", newString: "BETA" });
    assert.equal(r.ok, true);
    const out = readFileSync(f, "utf8");
    assert.equal(hasBom(out), true, "BOM preserved");
    assert.equal(detectNewline(out), "\r\n", "CRLF preserved");
    assert.equal(out, "﻿alpha\r\nBETA\r\ngamma\r\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write over a CRLF file re-encodes LF content back to CRLF", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "crlf.txt");
    writeFileSync(f, "a\r\nb\r\n");
    await t.executors.read({ filePath: "crlf.txt" });
    const r = await t.executors.write({ filePath: "crlf.txt", content: "x\ny\nz\n" });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(f, "utf8"), "x\r\ny\r\nz\r\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("LF file with no BOM is written byte-identical (no regression)", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const f = join(dir, "lf.txt");
    writeFileSync(f, "a\nb\nc\n");
    await t.executors.read({ filePath: "lf.txt" });
    const r = await t.executors.edit({ filePath: "lf.txt", oldString: "b", newString: "B" });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(f, "utf8"), "a\nB\nc\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- 2.3 external-directory gate via real handlers --------------------------

test("write to an absolute external path is refused by default", async () => {
  const dir = tmpWs();
  const outside = tmpWs();
  try {
    const t = await tools(dir);
    const target = join(outside, "escaped.txt");
    const r = await t.executors.write({ filePath: target, content: "nope\n" });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /outside the workspace root/i);
    // Must not have silently created the file.
    assert.throws(() => readFileSync(target, "utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("edit to a ../ escape path is refused by default", async () => {
  const dir = tmpWs();
  try {
    const t = await tools(dir);
    const r = await t.executors.edit({ filePath: "../escape.txt", oldString: "a", newString: "b" });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /outside the workspace root/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("external write goes through when the host approves (external_directory)", async () => {
  const dir = tmpWs();
  const outside = tmpWs();
  try {
    const t = await tools(dir);
    const target = join(outside, "ok.txt");
    const kinds = [];
    const r = await t.executors.write(
      { filePath: target, content: "approved\n" },
      { requestApproval: async (req) => { kinds.push(req.kind); return "accept"; } },
    );
    assert.equal(r.ok, true);
    assert.equal(kinds[0], "external_directory", "distinct approval kind requested");
    assert.equal(readFileSync(target, "utf8"), "approved\n");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("external write goes through with the allowExternal opt-in flag", async () => {
  const dir = tmpWs();
  const outside = tmpWs();
  try {
    const t = await tools(dir, { allowExternal: true });
    const target = join(outside, "ok.txt");
    const r = await t.executors.write({ filePath: target, content: "flagged\n" });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(target, "utf8"), "flagged\n");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
