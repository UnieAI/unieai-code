// The turn-entry prune has to be measured against the budget the coding layer
// declares, not agent-core's env default.
//
// engine.mjs prunes twice: once at turn entry (before the first request) and
// once per step inside the loop. Every in-loop call passed `ctx.contextTokens`;
// the turn-entry call did not, so it fell back to `AGENT_1_0_CONTEXT_TOKENS`'s
// 32k — the size agent-core was written against. A history between the two
// thresholds was therefore pruned on the way in and measured as comfortably
// under budget for the rest of the turn: the model lost tool output it had
// room for, and re-read the files to get it back.
//
// This drives a real turn through a stub gateway and looks at what actually
// went on the wire, because that is the only place the difference shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-entry-prune-"));
process.env.UNIEAI_HOME = HOME;
// The stub speaks chat-completions; applyUpstreamEnv honours an env already set.
process.env.AGENT_CORE_WIRE_API = "chat";

/** Streaming requests are the loop's steps; the summarizer's are not. */
const streamed = [];
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
    streamed.push(parsed.messages || []);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done." } }] })}\n\n`);
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
const { saveSession } = await import("./session.mjs");

// Four rounds of 40k-char tool output ≈ 40k estimated tokens. That sits above
// the 32k default's threshold (32k − 4k buffer) and far below the declared
// 128k one's — the exact window where the missing argument changed behaviour.
const OUTPUT_CHARS = 40_000;
const ROUNDS = 4;
const PRUNED_RE = /^\[tool output pruned/;

function sessionWithBigHistory(id) {
  const messages = [{ role: "system", content: "you are a coding agent" }];
  for (let i = 0; i < ROUNDS; i++) {
    messages.push({ role: "user", content: `read file ${i}` });
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read", arguments: `{"path":"f${i}"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: `f${i}:`.padEnd(OUTPUT_CHARS, "x") });
    messages.push({ role: "assistant", content: `read f${i}` });
  }
  saveSession({ id, model: "big-model", cwd: "/w", messages, updatedAt: Date.now() });
  return id;
}

/** Run one turn and hand back the messages of its first model request. */
async function firstRequestOf(engineOpts) {
  const id = sessionWithBigHistory(`prune-${Math.random().toString(36).slice(2)}`);
  const engine = createEngine({
    workspace: mkdtempSync(join(tmpdir(), "unieai-ws-prune-")),
    resume: id,
    ...engineOpts,
  });
  const before = streamed.length;
  await engine.send("carry on");
  assert.ok(streamed.length > before, "the turn made no model request");
  return streamed[before];
}

const toolOutputs = (messages) => messages.filter((m) => m.role === "tool").map((m) => String(m.content));

test("a history the declared budget has room for reaches the model intact", async () => {
  // 128k is the coding layer's default (engine.mjs), so no argument is needed
  // here beyond letting the default apply.
  const sent = toolOutputs(await firstRequestOf({}));
  assert.equal(sent.length, ROUNDS, "the tool rounds did not survive derivation");
  for (const [i, text] of sent.entries()) {
    assert.doesNotMatch(text, PRUNED_RE, `round ${i} was pruned against the wrong budget`);
    assert.equal(text.length, OUTPUT_CHARS, `round ${i} was truncated`);
  }
});

test("a budget the history genuinely exceeds still prunes on the way in", async () => {
  // The inverse: the argument is honoured, not merely absent. Without this the
  // test above would also pass if the turn-entry prune stopped running at all.
  const sent = toolOutputs(await firstRequestOf({ contextTokens: 32_000 }));
  assert.ok(
    sent.some((text) => PRUNED_RE.test(text)),
    "nothing was pruned against a budget the history is well over"
  );
});
