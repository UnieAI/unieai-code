// The prompt cache key has to be stable across a session's turns.
//
// A coding session re-sends a long, mostly-unchanged history on every step, so
// the upstream's prompt cache is worth more here than anywhere else — and we
// were sending no key at all, which is why measured cached_input_tokens was 0.
// The key must also not be the request id: that changes every step, which is a
// cache miss every step dressed up as a key.
//
// This runs on the Responses wire the coding layer actually defaults to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const HOME = mkdtempSync(join(tmpdir(), "unieai-prompt-cache-"));
process.env.UNIEAI_HOME = HOME;
// Deliberately NOT setting AGENT_CORE_WIRE_API: config.mjs picks "responses"
// for the coding layer, and that default is part of what is under test.

const requests = [];
const gateway = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    requests.push({ url: req.url, body: parsed });
    if (!parsed.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" } }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "done." })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`
    );
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

const steps = () => requests.filter((r) => r.body.stream);

test("every step of every turn carries the same key, and it is the session", async () => {
  const engine = createEngine({
    workspace: mkdtempSync(join(tmpdir(), "unieai-ws-cache-")),
    model: "big-model",
  });

  await engine.send("first");
  await engine.send("second");

  const sent = steps();
  assert.ok(sent.length >= 2, `expected a request per turn, saw ${sent.length}`);
  for (const r of sent) {
    assert.equal(r.body.prompt_cache_key, engine.sessionId, "a step went out under a different key");
  }
});

test("the coding layer's requests are Responses-shaped, with the prompt hoisted", async () => {
  const first = steps()[0];
  assert.ok(first.url.endsWith("/responses"), `not the responses endpoint: ${first.url}`);
  assert.match(first.body.instructions, /UnieAI Code/, "the system prompt did not become instructions");
  assert.ok(
    !first.body.input.some((i) => i.role === "system"),
    "the hoisted prompt is still being sent as an input item too"
  );
  assert.deepEqual(first.body.include, ["reasoning.encrypted_content"]);
});
