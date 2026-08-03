import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolset } from "../../third_party/unieai-agent-core/src/toolset.mjs";
import { ENTRY_TYPES, append, createTree, deriveContext } from "../../third_party/unieai-agent-core/src/session-tree.mjs";
import { listThreads } from "../../third_party/unieai-agent-core/src/agent-threads.mjs";

/**
 * The engine hands buildToolset an accessor over its live tree, exactly as
 * engine.mjs does. The accessor matters: the toolset is built once while the
 * tree is replaced on every append, so a captured value would go stale after
 * the first turn.
 */
async function wired() {
  let tree = append(createTree(), { type: ENTRY_TYPES.MESSAGE, message: { role: "user", content: "main line" } }, { id: "m0" });
  const toolset = await buildToolset({
    runtimeContext: { workspace: {} },
    ctx: { requestId: "r1" },
    sessionTree: { get: () => tree, set: (next) => { tree = next; } },
  });
  return { toolset, current: () => tree };
}

test("the thread tool is mounted once an accessor is supplied", async () => {
  const { toolset } = await wired();
  assert.ok(toolset.toolNames.includes("thread"));
});

test("without an accessor the tool is absent rather than inert", async () => {
  const toolset = await buildToolset({ runtimeContext: { workspace: {} }, ctx: { requestId: "r" } });
  assert.ok(!toolset.toolNames.includes("thread"));
});

test("opening a thread mutates the engine's own tree, not a copy", async () => {
  const { toolset, current } = await wired();
  const before = current();

  const opened = await toolset.execute("thread", { action: "open", name: "spike", task: "try approach X" });
  assert.equal(opened.ok, true, opened.modelText);
  assert.notEqual(current(), before, "the accessor never wrote back");
  assert.equal(listThreads(current()).length, 1);
});

test("the accessor keeps working across several calls, not just the first", async () => {
  const { toolset, current } = await wired();
  await toolset.execute("thread", { action: "open", name: "a", task: "first" });
  await toolset.execute("thread", { action: "switch", id: "root" });
  await toolset.execute("thread", { action: "open", name: "b", task: "second" });
  assert.equal(listThreads(current()).length, 2, "a stale captured tree would have lost one");
});

test("a finished thread puts only its conclusion on the main line", async () => {
  const { toolset, current } = await wired();
  const opened = await toolset.execute("thread", { action: "open", name: "spike", task: "a long exploration" });
  const id = opened.metadata.data.threads[0].id;
  await toolset.execute("thread", { action: "finish", id, conclusion: "approach X is out" });

  const contents = deriveContext(current()).messages.map((m) => String(m.content));
  assert.ok(contents.some((c) => c.includes("approach X is out")));
  assert.ok(!contents.some((c) => c.includes("a long exploration")), "the exploration rode along");
});

test("thread moves emit a timeline event so a host can show them", async () => {
  const { toolset } = await wired();
  const opened = await toolset.execute("thread", { action: "open", name: "spike", task: "t" });
  assert.equal(opened.metadata.timelineEvent.type, "thread_open");

  const switched = await toolset.execute("thread", { action: "switch", id: "root" });
  assert.equal(switched.metadata.timelineEvent.type, "thread_switch");
  assert.equal(switched.metadata.timelineEvent.threadId, null, "the main line is not a thread id");
});

test("a sub-agent gets no thread tool", async () => {
  let tree = createTree();
  const toolset = await buildToolset({
    runtimeContext: { workspace: {} },
    ctx: { requestId: "r" },
    forSubagent: true,
    sessionTree: { get: () => tree, set: (next) => { tree = next; } },
  });
  assert.ok(!toolset.toolNames.includes("thread"), "a sub-agent could fork where nobody looks");
});
