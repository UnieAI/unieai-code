// A long turn now folds its history instead of clipping tool outputs.
//
// The old behaviour pruned tool messages every step once history passed the
// budget — repeatedly, and always the same way: throw away what the model had
// just read. Folding replaces the older turns with a summary once, so what was
// learned survives in a form the model can still use.
//
// The hard part is not the fold, it is the bookkeeping around it: the session
// tree records a turn's messages only when the turn ends, so a mid-turn fold has
// to record what has happened so far before it can collapse any of it, and move
// the turn boundary with the array. This drives a real turn to check that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-midturn-fold-"));
process.env.UNIEAI_HOME = HOME;
process.env.AGENT_CORE_WIRE_API = "chat";

// Several rounds of moderate bulk — what a long coding turn actually looks
// like. One enormous message could not be folded anyway: the newest round is
// always kept, because summarizing work whose result the model has not seen
// yet is worse than being over budget.
// Each round's bulk is distinguishable, so a bookkeeping slip that replays a
// round shows up as a duplicate rather than hiding in identical padding.
const BULK = (n) => `round-${n} ` + "x".repeat(24_000);
const ROUNDS = 4;
const SUMMARY = "## Objective\nfold me\n\n## Work State\nstill going";

const streamed = [];
const summarized = [];
let step = 0;
const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    if (!parsed.stream) {
      summarized.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
      return;
    }
    streamed.push(parsed.messages || []);
    step += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (step <= ROUNDS) {
      // Bulk text AND a tool call: the call keeps the loop going to another
      // step, which is where the budget check lives.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: BULK(step) } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: `c${step}`, type: "function", function: { name: "todowrite", arguments: `{"todos":[{"content":"round ${step}","status":"in_progress"}]}` } }] },
            finish_reason: "tool_calls",
          }],
        })}\n\n`
      );
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done." }, finish_reason: "stop" }] })}\n\n`);
    }
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

const events = [];
const engine = createEngine({
  workspace: mkdtempSync(join(tmpdir(), "unieai-ws-fold-")),
  model: "big-model",
  // Small enough that one bulky step crosses 90% of it.
  contextTokens: 20_000,
  onToolEvent: (e) => events.push(e),
});
await engine.send("go");

test("the history is folded mid-turn, not pruned", () => {
  const folds = events.filter((e) => e.type === "context_compaction");
  assert.ok(folds.length >= 1, `expected a fold, saw ${JSON.stringify(events.map((e) => e.type))}`);
  for (const f of folds) assert.ok(f.after < f.before, "a fold did not shrink the history");
  assert.equal(
    events.filter((e) => e.type === "context_prune").length,
    0,
    "tool outputs were clipped even though a summarizer was available"
  );
});

test("the folded request is what the next step actually sends", () => {
  const sizes = streamed.map((m) => JSON.stringify(m).length);
  const shrank = sizes.findIndex((size, i) => i > 0 && size < sizes[i - 1]);
  assert.ok(shrank > 0, `no request was smaller than the one before it: ${sizes.join(" → ")}`);
  const summary = streamed[shrank].find((m) => String(m.content ?? "").includes("<conversation_summary>"));
  assert.ok(summary, "the summary never reached the model");
  assert.match(summary.content, /fold me/);
});

test("the fold is an entry in the tree, and the turn is still recorded once", () => {
  const entries = engine.sessionTree.entries;
  assert.equal(
    entries.filter((e) => e.type === ENTRY_TYPES.COMPACTION).length,
    1,
    "the fold did not land in the tree"
  );
  // The turn's own messages must appear exactly once as entries — recording
  // them before the fold and again at turn end would duplicate the whole turn.
  const userGo = entries.filter(
    (e) => e.type === ENTRY_TYPES.MESSAGE && e.message?.role === "user" && e.message?.content === "go"
  );
  assert.equal(userGo.length, 1, "the turn was recorded more than once");
});

test("the summarizer ran on the aux model, mid-turn", () => {
  assert.ok(summarized.length >= 1, "no summarization call was made");
  assert.equal(summarized[0].model, "small-model", "the fold burned the main model's budget");
});

test("the next turn derives a coherent prompt from the folded tree", async () => {
  // The fold is an entry, not a splice, so the next prompt is derived through
  // it. This is the check that the tree bookkeeping actually held: a wrong
  // firstKeptId here shows up as a duplicated or truncated history.
  const derived = engine.messages;
  assert.equal(derived[0].role, "system");
  assert.ok(
    derived.some((m) => String(m.content ?? "").includes("<conversation_summary>")),
    "the derived prompt lost the summary"
  );
  // Rounds may legitimately survive — the newest is always kept, and the turn
  // kept working after the fold. What must NOT happen is a round appearing
  // twice: that is what recording the same messages on both sides of the fold
  // would look like.
  const rounds = derived
    .map((m) => String(m.content ?? "").match(/^round-(\d+)/)?.[1])
    .filter(Boolean);
  assert.equal(new Set(rounds).size, rounds.length, `a round was replayed: ${rounds.join(",")}`);

  const before = streamed.length;
  await engine.send("and now finish");
  assert.ok(streamed.length > before, "the session could not run another turn");
  const sent = streamed.at(-1);
  assert.equal(sent.at(-1).content, "and now finish");
  assert.equal(sent[0].role, "system");
});
