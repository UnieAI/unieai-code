import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

const ORIGINAL = "alpha\nbeta\ngamma\n";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "unieai-concurrent-"));
  await writeFile(join(root, "f.txt"), ORIGINAL);
  const tools = await buildCodingTools({ workspace: root })();
  // The staleness guard only engages once the model has read the file.
  await tools.executors.read({ filePath: "f.txt" });
  return { root, tools };
}

test("two concurrent edits to one file both apply", async () => {
  const { root, tools } = await fixture();

  const [a, b] = await Promise.all([
    tools.executors.edit({ filePath: "f.txt", oldString: "alpha", newString: "ALPHA" }),
    tools.executors.edit({ filePath: "f.txt", oldString: "gamma", newString: "GAMMA" }),
  ]);

  // Before the queue, whichever landed second hit the staleness guard and was
  // refused even though its edit was perfectly valid.
  assert.equal(a.ok, true, `first edit failed: ${a.modelText}`);
  assert.equal(b.ok, true, `second edit failed: ${b.modelText}`);

  const after = await readFile(join(root, "f.txt"), "utf8");
  assert.match(after, /ALPHA/);
  assert.match(after, /GAMMA/);
  assert.match(after, /beta/, "the untouched line must survive both edits");
});

test("concurrent writes to one file serialize instead of interleaving", async () => {
  const { root, tools } = await fixture();

  await Promise.all([
    tools.executors.write({ filePath: "f.txt", content: "first\n" }),
    tools.executors.write({ filePath: "f.txt", content: "second\n" }),
  ]);

  // One of them wins outright; the file must be exactly one of the two, never
  // a blend of both.
  const after = await readFile(join(root, "f.txt"), "utf8");
  assert.ok(after === "first\n" || after === "second\n", `interleaved write produced: ${JSON.stringify(after)}`);
});

test("edits to different files still run concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "unieai-concurrent-two-"));
  await writeFile(join(root, "a.txt"), "one\n");
  await writeFile(join(root, "b.txt"), "two\n");
  const tools = await buildCodingTools({ workspace: root })();
  await Promise.all([
    tools.executors.read({ filePath: "a.txt" }),
    tools.executors.read({ filePath: "b.txt" }),
  ]);

  const [a, b] = await Promise.all([
    tools.executors.edit({ filePath: "a.txt", oldString: "one", newString: "ONE" }),
    tools.executors.edit({ filePath: "b.txt", oldString: "two", newString: "TWO" }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "ONE\n");
  assert.equal(await readFile(join(root, "b.txt"), "utf8"), "TWO\n");
});

test("a failing edit does not block the next one on the same file", async () => {
  const { root, tools } = await fixture();

  const [bad, good] = await Promise.all([
    tools.executors.edit({ filePath: "f.txt", oldString: "nowhere-in-file", newString: "x" }),
    tools.executors.edit({ filePath: "f.txt", oldString: "beta", newString: "BETA" }),
  ]);

  assert.equal(bad.ok, false, "a missing oldString should still fail");
  assert.equal(good.ok, true, `the queued edit was blocked: ${good.modelText}`);
  assert.match(await readFile(join(root, "f.txt"), "utf8"), /BETA/);
});
