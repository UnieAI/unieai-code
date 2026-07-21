import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point UNIEAI_HOME at an isolated temp dir BEFORE importing the store (config
// reads it at call time, so setting it here is enough).
const home = mkdtempSync(join(tmpdir(), "tos-"));
process.env.UNIEAI_HOME = home;

const { spillIfLarge, readSpilled } = await import("./tool-output-store.mjs");

test("small output is returned inline, not spilled", () => {
  const r = spillIfLarge("hello", { id: "bash" });
  assert.equal(r.spilled, false);
  assert.equal(r.modelText, "hello");
});

test("large output spills, preview has head+tail and a retrievable id", () => {
  const big = "HEAD" + "x".repeat(20000) + "TAIL";
  const r = spillIfLarge(big, { id: "bash", limit: 12000 });
  assert.equal(r.spilled, true);
  assert.ok(r.id && /^bash-/.test(r.id));
  assert.match(r.modelText, /^HEAD/);
  assert.match(r.modelText, /TAIL$/);
  assert.match(r.modelText, /read_output\("bash-/);
  assert.ok(r.modelText.length < big.length, "preview is shorter than the original");

  // Full content is retrievable by id.
  const back = readSpilled(r.id);
  assert.equal(back.ok, true);
  assert.equal(back.text, big);
});

test("read_output can grep the spilled content", () => {
  const lines = ["alpha match", "beta", "gamma match", "delta"].join("\n") + "\n" + "z".repeat(15000);
  const r = spillIfLarge(lines, { id: "read", limit: 100 });
  const got = readSpilled(r.id, { grep: "match" });
  assert.equal(got.ok, true);
  assert.deepEqual(got.text.split("\n"), ["alpha match", "gamma match"]);
});

test("read_output rejects an invalid or missing id", () => {
  assert.equal(readSpilled("../etc/passwd").ok, false);
  assert.equal(readSpilled("nonexistent-xyz").ok, false);
});

test("spill falls back to truncation when the store write fails", () => {
  // Point UNIEAI_HOME AT A FILE, so mkdir'ing tool-output/ under it fails
  // (ENOTDIR). spill must degrade to the provided fallback, not throw.
  const saved = process.env.UNIEAI_HOME;
  const asFile = join(home, "not-a-dir");
  writeFileSync(asFile, "x");
  process.env.UNIEAI_HOME = asFile;
  try {
    const big = "y".repeat(20000);
    const r = spillIfLarge(big, { id: "bash", limit: 100, fallbackTruncate: () => "FELL-BACK" });
    assert.equal(r.spilled, false);
    assert.equal(r.modelText, "FELL-BACK");
  } finally {
    process.env.UNIEAI_HOME = saved;
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
