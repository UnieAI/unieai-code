// A compaction is not a conversation.
//
// The engine serializes turns on one chain, and `steer()` used to accept text
// whenever that chain was busy. Once compaction became something a user can ask
// for explicitly, "busy" stopped meaning "a turn is running": steering into a
// compaction would hand the instruction to a loop that has no tools, no user,
// and no way to act on it — and the turn it was meant for would never see it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-task-kinds-"));
process.env.UNIEAI_HOME = HOME;
process.env.AGENT_CORE_WIRE_API = "chat";

const SUMMARY = "## Objective\nthe folded work";
let holdSummary = null; // set to a promise to keep a compaction in flight

const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    if (!parsed.stream) {
      if (holdSummary) await holdSummary;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok." }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
gateway.unref();

writeFileSync(
  join(HOME, "unieai.json"),
  JSON.stringify({
    gateway_base_url: `http://127.0.0.1:${gateway.address().port}`,
    gateway_api_key: "test-key",
    studio_url: "http://127.0.0.1:9",
    available_model_ids: ["big-model", "small-model"],
  }),
  "utf8"
);

const { createEngine } = await import("./engine.mjs");
const { ENTRY_TYPES } = await import("../../third_party/unieai-agent-core/src/session-tree.mjs");

const newEngine = () =>
  createEngine({ workspace: mkdtempSync(join(tmpdir(), "unieai-ws-kinds-")), model: "big-model" });

test("steering an idle session is refused, as before", () => {
  assert.equal(newEngine().steer("do it differently"), false);
});

test("steering a compaction is refused — it cannot act on it", async () => {
  const engine = newEngine();
  await engine.send("first");
  await engine.send("second");

  let release;
  holdSummary = new Promise((r) => { release = r; });
  const compacting = engine.compact();
  await new Promise((r) => setImmediate(r));

  assert.equal(engine.isBusy(), true, "the compaction is not on the chain");
  assert.equal(engine.steer("actually, do X"), false, "the interjection was swallowed by a compaction");

  release();
  holdSummary = null;
  await compacting;
});

test("an explicit compaction folds the history and records it in the tree", async () => {
  const engine = newEngine();
  await engine.send("first");
  await engine.send("second");
  const before = engine.messages.length;

  assert.equal(await engine.compact(), true, "nothing was folded");
  assert.ok(engine.messages.length < before, `history did not shrink: ${before} → ${engine.messages.length}`);
  assert.equal(
    engine.sessionTree.entries.filter((e) => e.type === ENTRY_TYPES.COMPACTION).length >= 1,
    true,
    "the fold is not in the tree"
  );
  assert.ok(
    engine.messages.some((m) => String(m.content ?? "").includes("the folded work")),
    "the summary is not in the derived prompt"
  );
});

test("compaction is serialized with turns, not concurrent with them", async () => {
  const engine = newEngine();
  await engine.send("first");
  const order = [];
  const turn = engine.send("second").then(() => order.push("turn"));
  const fold = engine.compact().then(() => order.push("compact"));
  await Promise.all([turn, fold]);
  assert.deepEqual(order, ["turn", "compact"], "the compaction overtook the turn it was queued behind");
});
