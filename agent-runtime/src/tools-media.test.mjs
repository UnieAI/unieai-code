import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, buildCodingTools } from "./tools.mjs";
import { solidColorPng } from "../../third_party/unieai-agent-core/src/vision.mjs";

/** A workspace holding one real PNG and one text file. */
async function fixture({ visionModel = "qwen-vl", callModelJson = async () => "A red square." } = {}) {
  const root = await mkdtemp(join(tmpdir(), "unieai-media-"));
  await writeFile(join(root, "shot.png"), solidColorPng([220, 20, 20], 8));
  await writeFile(join(root, "notes.txt"), "not an image");
  const tools = await buildCodingTools({ workspace: root, visionModel, callModelJson })();
  return { root, tools };
}

test("read_media_file is registered", async () => {
  const { tools } = await fixture();
  assert.ok(tools.schemas.some((s) => s.function.name === "read_media_file"));
});

test("an image is described by the vision model, and only prose comes back", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.read_media_file({ filePath: "shot.png" });
  assert.equal(r.ok, true);
  assert.match(r.modelText, /A red square\./);
  assert.match(r.modelText, /described by qwen-vl/);
  // The main model must never receive base64 — that is the whole point of delegating.
  assert.ok(!r.modelText.includes("base64"), "image data leaked to the main model");
});

test("the image actually reaches the vision model as a data URL", async () => {
  let seen = null;
  const { tools } = await fixture({ callModelJson: async (a) => { seen = a; return "ok"; } });
  await tools.executors.read_media_file({ filePath: "shot.png" });
  const part = seen.messages[0].content.find((p) => p.type === "image_url");
  assert.match(part.image_url.url, /^data:image\/png;base64,/);
  assert.equal(seen.baseModelSlug, "qwen-vl");
});

test("a caller question is forwarded instead of the default prompt", async () => {
  let asked = "";
  const { tools } = await fixture({ callModelJson: async (a) => { asked = a.messages[0].content[0].text; return "3"; } });
  await tools.executors.read_media_file({ filePath: "shot.png", prompt: "How many buttons?" });
  assert.equal(asked, "How many buttons?");
});

test("with no vision model the tool points at /vision-model rather than failing blankly", async () => {
  const { tools } = await fixture({ visionModel: null });
  const r = await tools.executors.read_media_file({ filePath: "shot.png" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /vision-model|\/vlm/);
});

test("the vision model is checked before the file is read", async () => {
  const { tools } = await fixture({ visionModel: null });
  // A path that does not exist would produce a read error if the order were wrong.
  const r = await tools.executors.read_media_file({ filePath: "absent.png" });
  assert.match(r.modelText, /no vision model is configured/);
});

test("a non-image extension is refused and redirected to read", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.read_media_file({ filePath: "notes.txt" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /not a supported image/);
  assert.match(r.modelText, /Use read for text files/);
});

test("filePath is required", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.read_media_file({});
  assert.equal(r.ok, false);
  assert.match(r.modelText, /filePath is required/);
});

test("a missing file reports the read error", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.read_media_file({ filePath: "nope.png" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /ENOENT|no such file/i);
});

test("an oversized image is refused rather than silently truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "unieai-media-big-"));
  await writeFile(join(root, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  const tools = await buildCodingTools({ workspace: root, visionModel: "vlm", callModelJson: async () => "x" })();
  const r = await tools.executors.read_media_file({ filePath: "huge.png" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /over the 5MB limit/);
});

test("a vision-model failure surfaces as an actionable tool error", async () => {
  const { tools } = await fixture({ callModelJson: async () => { throw new Error("503 upstream"); } });
  const r = await tools.executors.read_media_file({ filePath: "shot.png" });
  assert.equal(r.ok, false);
  assert.match(r.modelText, /503 upstream/);
});

test("the timeline event records what was read and by which model", async () => {
  const { tools } = await fixture();
  const r = await tools.executors.read_media_file({ filePath: "shot.png" });
  assert.equal(r.metadata.timelineEvent.type, "media_read");
  assert.equal(r.metadata.timelineEvent.path, "shot.png");
  assert.equal(r.metadata.timelineEvent.model, "qwen-vl");
});
