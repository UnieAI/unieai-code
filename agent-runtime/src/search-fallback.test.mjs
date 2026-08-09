import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";
import { globToRegExp, grepFiles, globFiles, walkFiles } from "./search-fallback.mjs";
import { readSpilled } from "./tool-output-store.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unieai-fallback-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "alpha.ts"), "export const NEEDLE = 1;\nconst other = 2;\n");
  await writeFile(join(root, "src", "beta.js"), "// nothing to find here\n");
  await writeFile(join(root, "README.md"), "NEEDLE appears in prose too\n");
  await writeFile(join(root, "node_modules", "pkg", "index.js"), "NEEDLE should be skipped\n");
  return root;
}

/** Run `fn` as if ripgrep were not installed. */
async function withoutRipgrep(fn) {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test("globToRegExp handles *, **, ? and {a,b}", () => {
  assert.ok(globToRegExp("*.py").test("main.py"));
  assert.ok(!globToRegExp("*.py").test("main.pyc"));
  assert.ok(globToRegExp("**/test_*.py").test("a/b/test_x.py"));
  assert.ok(globToRegExp("*.{ts,js}").test("a.js"));
  assert.ok(globToRegExp("f?o.txt").test("foo.txt"));
});

test("walkFiles skips dependency and VCS directories", async () => {
  const root = await fixture();
  const files = walkFiles(root);
  assert.ok(files.some((f) => f.endsWith("alpha.ts")));
  assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules must not be walked");
});

test("grepFiles finds matches with rg-shaped path:line:text output", async () => {
  const root = await fixture();
  const { lines } = grepFiles(root, root, { pattern: "NEEDLE" });
  assert.equal(lines.length, 2, `expected 2 hits, got ${lines.join(" | ")}`);
  assert.ok(lines.every((l) => /:\d+:/.test(l)));
});

test("grepFiles honours ignoreCase and the glob filter", async () => {
  const root = await fixture();
  assert.equal(grepFiles(root, root, { pattern: "needle" }).lines.length, 0);
  assert.equal(grepFiles(root, root, { pattern: "needle", ignoreCase: true }).lines.length, 2);
  assert.equal(grepFiles(root, root, { pattern: "NEEDLE", glob: "*.ts" }).lines.length, 1);
});

test("globFiles matches by basename and by path", async () => {
  const root = await fixture();
  assert.equal(globFiles(root, root, "*.ts").length, 1);
  assert.equal(globFiles(root, root, "src/*.js").length, 1);
});

test("grep tool falls back to JS search when ripgrep is missing", async () => {
  const root = await fixture();
  const tools = await buildCodingTools({ workspace: root })();
  const r = await withoutRipgrep(() => tools.executors.grep({ pattern: "NEEDLE" }));
  assert.equal(r.ok, true, `fallback must succeed, got: ${r.modelText}`);
  assert.match(r.modelText, /src\/alpha\.ts/);
  assert.ok(!r.modelText.includes("ripgrep"), "must not surface a ripgrep error");
});

test("glob tool falls back to JS search when ripgrep is missing", async () => {
  const root = await fixture();
  const tools = await buildCodingTools({ workspace: root })();
  const r = await withoutRipgrep(() => tools.executors.glob({ pattern: "*.ts" }));
  assert.equal(r.ok, true, `fallback must succeed, got: ${r.modelText}`);
  assert.match(r.modelText, /alpha\.ts/);
});

test("grep fallback reports no matches as success, not failure", async () => {
  const root = await fixture();
  const tools = await buildCodingTools({ workspace: root })();
  const r = await withoutRipgrep(() => tools.executors.grep({ pattern: "ZZZ_NOT_PRESENT" }));
  assert.equal(r.ok, true);
  assert.match(r.modelText, /No matches/);
});

test("read_output on an unknown id offers the ids that do exist", () => {
  const r = readSpilled("read-definitely-not-a-real-id");
  assert.equal(r.ok, false);
  // Either a list of real ids or an explicit "nothing stored" — never a bare
  // "it may have expired", which models cannot act on.
  assert.ok(/Available ids|No outputs are stored/.test(r.text), r.text);
});
