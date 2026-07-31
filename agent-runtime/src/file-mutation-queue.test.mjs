import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalKey, createFileMutationQueue } from "./file-mutation-queue.mjs";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("work on one file runs one at a time, in the order queued", async () => {
  const q = createFileMutationQueue();
  const order = [];
  await Promise.all([
    q.run("a.ts", async () => { order.push("start-1"); await tick(20); order.push("end-1"); }),
    q.run("a.ts", async () => { order.push("start-2"); await tick(1); order.push("end-2"); }),
  ]);
  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2"]);
});

test("different files are not serialized against each other", async () => {
  const q = createFileMutationQueue();
  const order = [];
  await Promise.all([
    q.run("a.ts", async () => { order.push("a-start"); await tick(20); order.push("a-end"); }),
    q.run("b.ts", async () => { order.push("b-start"); await tick(1); order.push("b-end"); }),
  ]);
  // b must finish while a is still sleeping.
  assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
});

test("paths spelled differently are the same file", async () => {
  const root = await mkdtemp(join(tmpdir(), "unieai-queue-"));
  await writeFile(join(root, "a.ts"), "x");
  const q = createFileMutationQueue();
  const order = [];
  await Promise.all([
    q.run(join(root, "a.ts"), async () => { order.push("s1"); await tick(20); order.push("e1"); }),
    q.run(join(root, ".", "a.ts"), async () => { order.push("s2"); order.push("e2"); }),
  ]);
  assert.deepEqual(order, ["s1", "e1", "s2", "e2"], "a differently spelled path took its own queue");
});

test("a symlink and its target share one queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "unieai-queue-link-"));
  await writeFile(join(root, "real.ts"), "x");
  await symlink(join(root, "real.ts"), join(root, "link.ts"));
  const q = createFileMutationQueue();
  const order = [];
  await Promise.all([
    q.run(join(root, "real.ts"), async () => { order.push("s1"); await tick(20); order.push("e1"); }),
    q.run(join(root, "link.ts"), async () => { order.push("s2"); order.push("e2"); }),
  ]);
  assert.deepEqual(order, ["s1", "e1", "s2", "e2"]);
});

test("a file that does not exist yet still gets a stable key", async () => {
  const root = await mkdtemp(join(tmpdir(), "unieai-queue-new-"));
  const a = canonicalKey(join(root, "does-not-exist.ts"));
  const b = canonicalKey(join(root, ".", "does-not-exist.ts"));
  assert.equal(a, b, "two creates of the same new file must share a queue");
});

test("a failure does not cancel the next item in line", async () => {
  const q = createFileMutationQueue();
  const ran = [];
  const failed = q.run("a.ts", async () => { ran.push("first"); throw new Error("edit conflict"); });
  const after = q.run("a.ts", async () => { ran.push("second"); return "ok"; });

  await assert.rejects(failed, /edit conflict/);
  assert.equal(await after, "ok");
  assert.deepEqual(ran, ["first", "second"]);
});

test("the caller receives its own result and its own error", async () => {
  const q = createFileMutationQueue();
  assert.equal(await q.run("a.ts", async () => 42), 42);
  await assert.rejects(q.run("a.ts", async () => { throw new Error("boom"); }), /boom/);
});

test("queues are released, so a long session does not accumulate them", async () => {
  const q = createFileMutationQueue();
  await q.run("a.ts", async () => {});
  await q.run("b.ts", async () => {});
  assert.equal(q.size, 0, "finished queues must be dropped");
});

test("separate instances never share locks", async () => {
  const [q1, q2] = [createFileMutationQueue(), createFileMutationQueue()];
  const order = [];
  await Promise.all([
    q1.run("a.ts", async () => { order.push("q1-start"); await tick(20); order.push("q1-end"); }),
    q2.run("a.ts", async () => { order.push("q2-start"); order.push("q2-end"); }),
  ]);
  // Two concurrent requests must not block each other.
  assert.deepEqual(order, ["q1-start", "q2-start", "q2-end", "q1-end"]);
});
