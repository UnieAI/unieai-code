import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreMemoryStorage, readCoreMemorySync } from "./memory-store.mjs";
import { buildToolset } from "../../third_party/unieai-agent-core/src/toolset.mjs";
import { renderCoreMemoryBlock } from "../../third_party/unieai-agent-core/src/memory-core.mjs";

const SCOPE = "ws-/repo/alpha";

/** A toolset wired the way the engine wires it, against a throwaway store. */
async function wired(dir, scope = SCOPE) {
  return buildToolset({
    runtimeContext: { workspace: { memory: { enabled: true } } },
    memoryWrite: createCoreMemoryStorage({ dir }),
    ctx: { requestId: "r1", customModelId: scope },
  });
}

test("memory is mounted only when the workspace enables it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));
  const off = await buildToolset({
    runtimeContext: { workspace: {} },
    memoryWrite: createCoreMemoryStorage({ dir }),
    ctx: { requestId: "r", customModelId: SCOPE },
  });
  assert.ok(!off.toolNames.includes("memory"), "memory mounted without being enabled");

  const on = await wired(dir);
  assert.ok(on.toolNames.includes("memory"), "memory did not mount when enabled");
});

test("a fact written in one session is rendered into the next session's prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));

  // Session one writes.
  const first = await wired(dir);
  const wrote = await first.execute("memory", {
    target: "memory",
    action: "add",
    content: "The build runs through bazel, not cargo directly.",
  });
  assert.equal(wrote.ok, true, `write failed: ${wrote.modelText}`);

  // Session two reads — this is the half that did not exist before wiring.
  const block = renderCoreMemoryBlock(readCoreMemorySync(SCOPE, { dir }), { toolEnabled: true });
  assert.match(block, /bazel, not cargo/, "the fact never reached the next prompt");
});

test("memory is scoped per project, so one repo cannot read another's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));
  const alpha = await wired(dir, "ws-/repo/alpha");
  await alpha.execute("memory", { target: "memory", action: "add", content: "alpha uses bazel" });

  const beta = renderCoreMemoryBlock(readCoreMemorySync("ws-/repo/beta", { dir }), { toolEnabled: true });
  assert.ok(!beta.includes("alpha uses bazel"), "one project's memory leaked into another");

  const back = renderCoreMemoryBlock(readCoreMemorySync("ws-/repo/alpha", { dir }), { toolEnabled: true });
  assert.match(back, /alpha uses bazel/);
});

test("a project with nothing remembered yet renders without a stale fact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));
  const block = renderCoreMemoryBlock(readCoreMemorySync("ws-/repo/fresh", { dir }), { toolEnabled: true });
  assert.ok(!block.includes("undefined"), `leaked a placeholder: ${block}`);
});

test("removing a fact stops it reaching later prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));
  const tools = await wired(dir);
  await tools.execute("memory", { target: "memory", action: "add", content: "temporary detail worth forgetting" });
  // remove locates the entry by a substring, not by resending the whole text.
  const removed = await tools.execute("memory", { target: "memory", action: "remove", old_text: "temporary detail" });
  assert.equal(removed.ok, true, `remove failed: ${removed.modelText}`);

  const block = renderCoreMemoryBlock(readCoreMemorySync(SCOPE, { dir }), { toolEnabled: true });
  assert.ok(!block.includes("temporary detail"), "a removed fact still reaches the prompt");
});

test("the sync and async reads agree, so recall does not depend on the caller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unieai-recall-"));
  const tools = await wired(dir);
  await tools.execute("memory", { target: "memory", action: "add", content: "a fact both readers must see" });

  const { readCoreMemory } = await import("./memory-store.mjs");
  const viaAsync = await readCoreMemory(SCOPE, { dir });
  const viaSync = readCoreMemorySync(SCOPE, { dir });
  assert.deepEqual(viaSync, viaAsync);
});
