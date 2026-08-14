// A turn killed before it ended used to be lost entirely.
//
// The engine writes its whole-tree snapshot when a turn finishes, so a process
// killed mid-turn came back to the state it had before the turn started — an
// hour of tool work gone because nothing had reached disk yet. Entries now reach
// an append-only log as they happen, and a resume replays them.
//
// This simulates the crash the honest way: run a turn, then throw away the
// snapshot the way a process that never reached `persist()` would have, and
// resume from what is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-crash-"));
process.env.UNIEAI_HOME = HOME;
process.env.AGENT_CORE_WIRE_API = "chat";

const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (!parsed.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "I looked at the parser." } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
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
const { rolloutPath } = await import("./session-rollout.mjs");
const { treePath } = await import("./session-tree-store.mjs");
const { legacyPath } = await import("./session-tree-store.mjs");

const workspace = mkdtempSync(join(tmpdir(), "unieai-ws-crash-"));

test("a turn that never reached the snapshot comes back from the log", async () => {
  const engine = createEngine({ workspace, model: "big-model" });
  const id = engine.sessionId;
  await engine.send("what does the parser do?");

  // Everything the turn produced is already in the log, before any rollback of
  // the snapshot below — that is the property under test.
  const logged = readFileSync(rolloutPath(id), "utf8");
  assert.match(logged, /what does the parser do\?/);
  assert.match(logged, /I looked at the parser\./);

  // The crash: the snapshot files a finished turn would have written are gone.
  // This is the first-turn case — a session killed before it ever wrote one.
  for (const p of [treePath(id), legacyPath(id)]) if (existsSync(p)) rmSync(p);

  const resumed = createEngine({ workspace, resume: id });
  const texts = resumed.messages.map((m) => String(m.content ?? ""));
  assert.ok(texts.some((t) => t.includes("what does the parser do?")), "the question was lost");
  assert.ok(texts.some((t) => t.includes("I looked at the parser.")), "the answer was lost");
  assert.equal(texts[0].includes("UnieAI Code"), true, "the system prompt was lost");
});

test("a snapshot older than the log is brought up to date on resume", async () => {
  const engine = createEngine({ workspace, model: "big-model" });
  const id = engine.sessionId;
  await engine.send("first question");

  // Roll the snapshot back to what it held before the turn — exactly what a
  // process killed mid-turn leaves behind.
  const snapshot = JSON.parse(readFileSync(treePath(id), "utf8"));
  const beforeTurn = snapshot.entries.filter((e) => e.type !== "message" || e.message?.role === "system");
  writeFileSync(
    treePath(id),
    JSON.stringify({ ...snapshot, entries: beforeTurn, leafId: beforeTurn.at(-1)?.id ?? null }),
    "utf8"
  );
  const stale = JSON.parse(readFileSync(treePath(id), "utf8"));
  assert.ok(stale.entries.length < snapshot.entries.length, "the rollback did not actually shrink the snapshot");

  const resumed = createEngine({ workspace, resume: id });
  const texts = resumed.messages.map((m) => String(m.content ?? ""));
  assert.ok(texts.some((t) => t.includes("first question")), "the user's turn was not recovered");
  assert.ok(texts.some((t) => t.includes("I looked at the parser.")), "the answer was not recovered");
});

test("resuming an intact session replays nothing and changes nothing", async () => {
  const engine = createEngine({ workspace, model: "big-model" });
  const id = engine.sessionId;
  await engine.send("a question");
  const before = createEngine({ workspace, resume: id }).messages;
  const again = createEngine({ workspace, resume: id }).messages;
  assert.deepEqual(again, before, "replay is not idempotent");
});
