import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

/** A throwaway workspace with a couple of files to search. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unieai-search-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "alpha.ts"), "export const NEEDLE = 1;\nconst other = 2;\n");
  await writeFile(join(root, "src", "beta.js"), "// nothing to find here\n");
  await writeFile(join(root, "README.md"), "NEEDLE appears in prose too\n");
  const tools = await buildCodingTools({ workspace: root })();
  return { root, tools };
}

test("grep and glob are registered as tools", async () => {
  const { tools } = await fixture();
  const names = tools.schemas.map((s) => s.function.name);
  assert.ok(names.includes("grep"));
  assert.ok(names.includes("glob"));
});

test("grep finds matches and reports workspace-relative paths", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.grep({ pattern: "NEEDLE" });
  assert.equal(r.ok, true);
  assert.match(r.modelText, /src\/alpha\.ts/);
  assert.match(r.modelText, /README\.md/);
  // Absolute paths would not line up with what read/edit expect.
  assert.ok(!r.modelText.includes(tmpdir()), `leaked absolute path: ${r.modelText}`);
});

test("grep honours the glob filter", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.grep({ pattern: "NEEDLE", glob: "*.ts" });
  assert.equal(r.ok, true);
  assert.match(r.modelText, /alpha\.ts/);
  assert.ok(!r.modelText.includes("README.md"));
});

test("grep treats no matches as success, not failure", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.grep({ pattern: "ZZZ_NOT_PRESENT_ZZZ" });
  assert.equal(r.ok, true, "ripgrep exit 1 means no matches, which is a valid result");
  assert.match(r.modelText, /No matches/i);
});

test("grep is case-insensitive on request", async () => {
  const { tools } = await fixture();
  const sensitive = await tools.executors.grep({ pattern: "needle" });
  assert.match(sensitive.modelText, /No matches/i);
  const insensitive = await tools.executors.grep({ pattern: "needle", ignoreCase: true });
  assert.match(insensitive.modelText, /alpha\.ts/);
});

test("grep requires a pattern", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.grep({});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /pattern is required/);
});

test("glob lists matching files as workspace-relative paths", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.glob({ pattern: "**/*.ts" });
  assert.equal(r.ok, true);
  assert.match(r.modelText, /src\/alpha\.ts/);
  assert.ok(!r.modelText.includes("beta.js"));
  assert.ok(!r.modelText.includes(tmpdir()), `leaked absolute path: ${r.modelText}`);
});

test("glob reports an empty match set without failing", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.glob({ pattern: "**/*.nope" });
  assert.equal(r.ok, true);
  assert.match(r.modelText, /No files match/i);
});

test("glob requires a pattern", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.glob({});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /pattern is required/);
});
