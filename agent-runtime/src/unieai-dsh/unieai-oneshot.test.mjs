// Copyright (c) 2026 UnieAI. All rights reserved.
// One tool-less model call for the client's hidden structured turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOneShotEngine, createOneShotModel, extractJsonObject, oneShotMessages } from "./unieai-oneshot.mjs";

test("extractJsonObject takes the object out of fences and prose", () => {
  assert.equal(extractJsonObject('{"title":"A"}'), '{"title":"A"}');
  assert.equal(extractJsonObject('```json\n{"title":"A"}\n```'), '{"title":"A"}');
  assert.equal(extractJsonObject('Sure: {"title":"A"} hope it helps'), '{"title":"A"}');
  assert.equal(extractJsonObject("no json here"), "no json here");
});

test("the schema reaches the model as response_format and as an instruction", async () => {
  let sent;
  const oneShot = createOneShotModel({
    credentials: () => ({ gatewayBaseUrl: "https://gw/v1", gatewayApiKey: "k" }),
    fetchImpl: async (url, init) => {
      sent = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '```json\n{"title":"Add two numbers"}\n```' } }] }) };
    },
  });
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const answer = await oneShot({ model: "M", prompt: "title this", outputSchema: schema });
  assert.equal(answer, '{"title":"Add two numbers"}');
  assert.equal(sent.url, "https://gw/v1/chat/completions");
  assert.equal(sent.auth, "Bearer k");
  assert.deepEqual(sent.body.response_format, { type: "json_schema", json_schema: { name: "output", schema, strict: true } });
  assert.equal(sent.body.tools, undefined, "no tools, ever");
  assert.match(sent.body.messages[0].content, /only one JSON object/);
  assert.deepEqual(oneShotMessages("p"), [{ role: "user", content: "p" }]);
});

test("the one-shot engine streams the answer as the turn's text", async () => {
  const texts = [];
  const engine = createOneShotEngine({ oneShot: async ({ prompt, outputSchema }) => `${prompt}:${outputSchema ? "json" : "text"}`, model: "M", onText: (t) => texts.push(t) });
  await engine.send("hi", { outputSchema: {} });
  assert.deepEqual(texts, ["hi:json"]);
});
