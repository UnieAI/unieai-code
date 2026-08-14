// apply_patch as a mounted tool: gated per model, sharing the same write policy
// and staleness guards as edit/write, and all-or-nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";
import { modelWantsApplyPatch } from "./engine.mjs";

const wrap = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

async function toolsIn(opts = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "unieai-patch-"));
  const build = buildCodingTools({ workspace, applyPatch: true, ...opts });
  return { ...(await build({})), workspace };
}

test("the tool is mounted only when the model is configured for it", async () => {
  const off = await toolsIn({ applyPatch: false });
  assert.ok(!off.schemas.some((s) => s.function.name === "apply_patch"));
  const on = await toolsIn();
  assert.ok(on.schemas.some((s) => s.function.name === "apply_patch"));
});

test("the model gate reads a configured list, and is off by default", () => {
  assert.equal(modelWantsApplyPatch("gpt-5-codex", {}), false, "it must not turn itself on");
  assert.equal(modelWantsApplyPatch("gpt-5-codex", { UNIEAI_APPLY_PATCH_MODELS: "codex,gpt-5" }), true);
  assert.equal(modelWantsApplyPatch("GLM-5.2", { UNIEAI_APPLY_PATCH_MODELS: "codex" }), false);
  assert.equal(modelWantsApplyPatch("", { UNIEAI_APPLY_PATCH_MODELS: "codex" }), false);
});

test("add, update and delete all land in one call", async () => {
  const t = await toolsIn();
  writeFileSync(join(t.workspace, "old.txt"), "keep\nchange\n", "utf8");
  writeFileSync(join(t.workspace, "gone.txt"), "bye\n", "utf8");

  const res = await t.executors.apply_patch({
    patch: wrap(
      "*** Add File: new.txt\n+fresh\n" +
      "*** Update File: old.txt\n@@\n keep\n-change\n+changed\n" +
      "*** Delete File: gone.txt"
    ),
  });

  assert.equal(res.ok, true, res.modelText);
  assert.equal(readFileSync(join(t.workspace, "new.txt"), "utf8"), "fresh\n");
  assert.equal(readFileSync(join(t.workspace, "old.txt"), "utf8"), "keep\nchanged\n");
  assert.ok(!existsSync(join(t.workspace, "gone.txt")));
});

test("a move rewrites the file at its new path and removes the old one", async () => {
  const t = await toolsIn();
  writeFileSync(join(t.workspace, "src.txt"), "line\n", "utf8");
  const res = await t.executors.apply_patch({
    patch: wrap("*** Update File: src.txt\n*** Move to: dst.txt\n@@\n-line\n+line2"),
  });
  assert.equal(res.ok, true, res.modelText);
  assert.equal(readFileSync(join(t.workspace, "dst.txt"), "utf8"), "line2\n");
  assert.ok(!existsSync(join(t.workspace, "src.txt")));
});

test("a patch that fails part way through changes nothing at all", async () => {
  // The whole reason parsing and applying are separate: a half-applied patch
  // leaves the workspace in a state neither the model nor the user described.
  const t = await toolsIn();
  writeFileSync(join(t.workspace, "first.txt"), "a\n", "utf8");
  writeFileSync(join(t.workspace, "second.txt"), "b\n", "utf8");

  const res = await t.executors.apply_patch({
    patch: wrap(
      "*** Update File: first.txt\n@@\n-a\n+A\n" +
      "*** Update File: second.txt\n@@\n-not-there\n+X"
    ),
  });

  assert.equal(res.ok, false);
  assert.match(res.modelText, /no part of the patch was applied/);
  assert.equal(readFileSync(join(t.workspace, "first.txt"), "utf8"), "a\n", "the first file was changed anyway");
});

test("a read-only session refuses the patch instead of applying it", async () => {
  const t = await toolsIn({ sandboxMode: "readOnly" });
  writeFileSync(join(t.workspace, "f.txt"), "a\n", "utf8");
  const res = await t.executors.apply_patch({ patch: wrap("*** Update File: f.txt\n@@\n-a\n+A") });
  assert.equal(res.ok, false);
  assert.match(res.modelText, /read-only/);
  assert.equal(readFileSync(join(t.workspace, "f.txt"), "utf8"), "a\n");
});

test("a path outside the workspace is refused, patch or not", async () => {
  const t = await toolsIn();
  const outside = join(tmpdir(), "unieai-patch-escape.txt");
  const res = await t.executors.apply_patch({ patch: wrap(`*** Add File: ${outside}\n+nope`) });
  assert.equal(res.ok, false);
  assert.match(res.modelText, /outside the workspace root/);
});

test("a malformed patch is refused with a message aimed at the model", async () => {
  const t = await toolsIn();
  const res = await t.executors.apply_patch({ patch: "*** Add File: x.txt\n+y" });
  assert.equal(res.ok, false);
  assert.match(res.modelText, /Begin Patch/);
});

test("each changed file gets its own timeline event", async () => {
  const t = await toolsIn();
  writeFileSync(join(t.workspace, "a.txt"), "1\n", "utf8");
  const res = await t.executors.apply_patch({
    patch: wrap("*** Update File: a.txt\n@@\n-1\n+2\n*** Add File: b.txt\n+new"),
  });
  assert.equal(res.ok, true, res.modelText);
  assert.equal(res.metadata.timelineEvents.length, 2);
  // Order is codex's, not the patch's — it reports adds before modifications.
  // Since it is the one applying, its account of what happened is the honest
  // one; pinning our own order here would be asserting a fiction.
  assert.deepEqual(
    res.metadata.timelineEvents.map((e) => `${e.kind} ${e.path}`).sort(),
    ["add b.txt", "update a.txt"]
  );
  // The loop reads `timelineEvent` to know a tool mutated something; without it
  // the doom guard would treat a successful patch as no progress.
  assert.equal(res.metadata.timelineEvent.type, "file_diff");
});
