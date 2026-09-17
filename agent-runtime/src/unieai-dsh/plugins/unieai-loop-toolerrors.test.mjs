// Copyright (c) 2026 UnieAI. All rights reserved.
// Tool-call error hints: available tools and parameter summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as plugin from "./unieai-loop-toolerrors.mjs";
import { fakeAgent, fakeContext } from "./unieai-loop-testkit.mjs";

const TOOLS = [
  { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string", description: "Shell command to run" }, timeout: { type: "number" } }, required: ["command"] } },
  { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"], additionalProperties: false } },
  { name: "edit", description: "edit", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object" } }, mode: { enum: ["replace", "insert"] } }, required: ["path", "edits"] } },
  { name: "todo_write", description: "todo", parameters: { type: "object", properties: {} } },
];

const errorResult = (code, message) => ({
  isError: true,
  content: [{ type: "text", text: `Error: ${message}` }],
  error: { message, info: { name: code === "UNKNOWN_TOOL" ? "ToolNotFoundError" : "ToolArgsError", code } },
});

function setup() {
  const agent = fakeAgent();
  const ctx = fakeContext({
    tools: {
      schemas: () => TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })),
      get: (name) => TOOLS.find((tool) => tool.name === name),
    },
  });
  plugin.apply(ctx);
  const post = (exec, result, inner = async () => ({ kind: "accept" })) => ctx.waterfall("tools/post-execute", { agent, callId: "c1", ...exec }, result, inner);
  return { post };
}

test("nearestNames", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(plugin.nearestNames("Bash", names), ["bash"]);
  assert.deepEqual(plugin.nearestNames("functions.read", names), ["read"]);
  assert.deepEqual(plugin.nearestNames("read_file", names)[0], "read");
  assert.deepEqual(plugin.nearestNames("todowrite", names), ["todo_write"]);
  assert.deepEqual(plugin.nearestNames("apply_patch", names), []);
});

test("unknown tools list what is available, with a suggestion", async () => {
  const { post } = setup();
  const decision = await post({ name: "Bash", arguments: {} }, errorResult("UNKNOWN_TOOL", 'unknown tool "Bash"'));
  assert.equal(decision.kind, "accept");
  const texts = decision.content.map((block) => block.text).join("\n");
  assert.match(texts, /^Error: unknown tool "Bash"/);
  assert.match(texts, /Did you mean "bash"\?/);
  assert.match(texts, /Available tools: bash, read, edit, todo_write\./);
});

test("invalid arguments show the parameter summary, required first", async () => {
  const { post } = setup();
  const decision = await post({ name: "edit", arguments: { path: "a" } }, errorResult("INVALID_ARGS", "invalid arguments: edits: required"));
  const hint = decision.content.at(-1).text;
  assert.match(hint, /Parameters of "edit"/);
  assert.ok(hint.indexOf("- path (string, required)") < hint.indexOf("- mode"), hint);
  assert.match(hint, /- edits \(array<object>, required\)/);
  assert.match(hint, /- mode \("replace"\|"insert"\)/);

  const closed = await post({ name: "read", arguments: "{bad json" }, errorResult("INVALID_ARGS", "invalid arguments: expected object"));
  assert.match(closed.content.at(-1).text, /No other parameters are accepted\./);
  const empty = await post({ name: "todo_write", arguments: { x: 1 } }, errorResult("INVALID_ARGS", "invalid arguments"));
  assert.match(empty.content.at(-1).text, /takes no parameters/);
});

test("successes, other errors, nested calls and rewritten decisions are left alone", async () => {
  const { post } = setup();
  const ok = { kind: "accept" };
  assert.deepEqual(await post({ name: "bash" }, { isError: false, content: [] }), ok);
  assert.deepEqual(await post({ name: "bash" }, errorResult("TIMEOUT", "timed out")), ok);
  assert.deepEqual(await post({ name: "nope", parent: Symbol("p") }, errorResult("UNKNOWN_TOOL", "unknown")), ok);
  const block = { kind: "block", feedback: [{ type: "text", text: "denied" }] };
  assert.deepEqual(await post({ name: "nope" }, errorResult("UNKNOWN_TOOL", "unknown"), async () => block), block);
  const contexts = { kind: "accept", additionalContexts: [{ id: "m" }] };
  const kept = await post({ name: "nope" }, errorResult("UNKNOWN_TOOL", "unknown"), async () => contexts);
  assert.deepEqual(kept.additionalContexts, contexts.additionalContexts, "downstream contexts survive");
  assert.ok(kept.content.length > 1);
});
