// The client renders by item `type`; a tool we map to the wrong type, or fail to
// map at all, shows up as a missing card rather than an error. These pin the
// mapping and the started/completed correlation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startedItem, completedItem, createItemBridge, userMessageItem, agentMessageItem } from "./items.mjs";

test("each tool maps to the card the client knows how to draw", () => {
  assert.equal(startedItem({ tool: "bash", args: { cmd: "ls" } }).type, "commandExecution");
  assert.equal(startedItem({ tool: "run_tests", args: { target: "t.py" } }).type, "commandExecution");
  assert.equal(startedItem({ tool: "read", args: { filePath: "a.py" } }).type, "fileRead");
  assert.equal(startedItem({ tool: "edit", args: { filePath: "a.py" } }).type, "fileChange");
  assert.equal(startedItem({ tool: "grep", args: { pattern: "x" } }).type, "search");
});

test("an unknown tool still produces a card instead of vanishing", () => {
  const item = startedItem({ tool: "some_new_tool", args: { a: 1 } });
  assert.equal(item.type, "toolCall");
  assert.equal(item.name, "some_new_tool");
  assert.equal(item.arguments, '{"a":1}');
});

test("a command card carries the command and, on completion, its exit code", () => {
  const start = startedItem({ tool: "bash", args: { cmd: "pytest -q" } });
  assert.equal(start.command, "pytest -q");
  assert.equal(start.status, "inProgress");
  const done = completedItem({ tool: "bash", id: start.id, ok: false, output: "boom", extra: { command: "pytest -q", exitCode: 2 } });
  assert.equal(done.status, "failed");
  assert.equal(done.exitCode, 2);
  assert.equal(done.aggregatedOutput, "boom");
});

test("huge tool output is capped so one command cannot flood the client", () => {
  const done = completedItem({ tool: "bash", id: "x", output: "y".repeat(50_000) });
  assert.ok(done.aggregatedOutput.length <= 20_000);
});

test("the bridge correlates a completion with the card its start created", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "t1", tool_name: "bash", args_preview: '{"cmd":"ls"}' });
  onEvent({ type: "tool_use_completed", tool_use_id: "t1", output_preview: "a\nb" });
  assert.deepEqual(seen.map(([m]) => m), ["item/started", "item/completed"]);
  assert.equal(seen[0][1].item.id, seen[1][1].item.id, "same card id");
  assert.equal(seen[1][1].item.command, "ls", "the command survives to completion");
});

test("a failed tool marks its card failed", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "t1", tool_name: "read", args_preview: '{"filePath":"a.py"}' });
  onEvent({ type: "tool_use_failed", tool_use_id: "t1", error: "ENOENT" });
  assert.equal(seen[1][1].item.status, "failed");
});

test("interleaved tools keep their own cards", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "a", tool_name: "bash", args_preview: '{"cmd":"one"}' });
  onEvent({ type: "tool_use_started", tool_use_id: "b", tool_name: "bash", args_preview: '{"cmd":"two"}' });
  onEvent({ type: "tool_use_completed", tool_use_id: "b", output_preview: "" });
  onEvent({ type: "tool_use_completed", tool_use_id: "a", output_preview: "" });
  const ids = seen.map(([, p]) => p.item.id);
  assert.equal(ids[1], ids[2], "b's completion lands on b's card");
  assert.equal(ids[0], ids[3], "a's completion lands on a's card");
});

test("engine-internal events produce no cards", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  for (const type of ["doom_warning", "completion_nudge", "context_prune", "retry"]) onEvent({ type });
  assert.deepEqual(seen, []);
});

test("a malformed args preview degrades to the raw string", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "t", tool_name: "bash", args_preview: "ls -la (not json)" });
  assert.equal(seen[0][1].item.command, "ls -la (not json)");
});

test("user and assistant messages match the protocol's content shape", () => {
  assert.deepEqual(userMessageItem("u1", "hi").content, [{ type: "text", text: "hi", text_elements: [] }]);
  assert.deepEqual(agentMessageItem("a1", "yo").content, [{ type: "text", text: "yo" }]);
});
