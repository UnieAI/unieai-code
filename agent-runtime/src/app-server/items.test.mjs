// The client renders by item `type`; a tool we map to the wrong type, or fail to
// map at all, shows up as a missing card rather than an error. These pin the
// mapping and the started/completed correlation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startedItem, completedItem, createItemBridge, userMessageItem, agentMessageItem, commandLabel } from "./items.mjs";

test("tools map to the two card types the client actually renders", () => {
  // The Rust engine only ever produces commandExecution and fileChange, and the
  // TUI's rendering is built around those; the semantically-truer fileRead and
  // search types drew a far plainer session than the same work under codex.
  for (const tool of ["bash", "run_tests", "read", "grep", "glob"]) {
    assert.equal(startedItem({ tool, args: {} }).type, "commandExecution", tool);
  }
  for (const tool of ["edit", "write"]) {
    assert.equal(startedItem({ tool, args: { filePath: "a.py" } }).type, "fileChange", tool);
  }
});

test("a tool call reads as the shell idiom that performs it", () => {
  assert.equal(commandLabel("bash", { cmd: "ls -la" }), "ls -la");
  assert.equal(commandLabel("read", { filePath: "a.py" }), "cat a.py");
  // A windowed read is shown as the range form rather than a whole-file cat.
  assert.equal(commandLabel("read", { filePath: "a.py", offset: 10, limit: 5 }), "sed -n '10,14p' a.py");
  assert.equal(commandLabel("grep", { pattern: "add(" }), 'rg "add("');
  assert.equal(commandLabel("glob", { pattern: "**/*.py" }), 'rg --files -g "**/*.py"');
  assert.match(commandLabel("run_tests", { target: "tests/test_a.py" }), /run tests tests\/test_a\.py/);
});

test("an unknown tool becomes a real item type, not an invented one", () => {
  // `toolCall` is not one of the protocol's 18 item types. The client drops
  // what it cannot deserialize, silently, so emitting one was the same as
  // emitting nothing — exactly the failure it was meant to avoid.
  const item = startedItem({ tool: "some_new_tool", args: { a: 1 } });
  assert.equal(item.type, "commandExecution");
  assert.equal(item.command, "some_new_tool");
  for (const key of ["cwd", "source", "commandActions", "aggregatedOutput"]) {
    assert.ok(key in item, `${key} is required by the protocol and missing`);
  }
});

test("a command item carries every field the protocol requires", () => {
  const item = startedItem({ tool: "bash", args: { cmd: "ls" }, cwd: "/w" });
  assert.deepEqual(
    Object.keys(item).sort(),
    ["aggregatedOutput", "command", "commandActions", "cwd", "durationMs", "exitCode", "id", "processId", "source", "status", "type"]
  );
});

test("a file change reports its kind, which the client renders by", () => {
  const done = completedItem({ tool: "edit", id: "i1", extra: { path: "a.py", kind: "update", diff: "@@" } });
  assert.deepEqual(done.changes, [{ path: "a.py", kind: { type: "update", movePath: null }, diff: "@@" }]);
  assert.ok(!("path" in done), "path is not a field of fileChange — it lives on each change");

  const added = completedItem({ tool: "write", id: "i2", extra: { path: "n.py", kind: "add", diff: "@@" } });
  assert.deepEqual(added.changes[0].kind, { type: "add" });
});

test("a read card survives to completion with its label intact", () => {
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "t1", tool_name: "read", args_preview: '{"filePath":"calc.py"}' });
  onEvent({ type: "file_read", tool_use_id: "t1", tool_name: "read", path: "calc.py" });
  assert.equal(seen[0][1].item.command, "cat calc.py");
  assert.equal(seen[1][1].item.command, "cat calc.py");
  assert.equal(seen[1][1].item.status, "completed");
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

test("user and assistant messages use their own, different shapes", () => {
  // Captured from a live session: a user message carries a `content` array of
  // parts; an agent message carries a plain `text` string. Reusing one shape for
  // both left the client with nothing to render for the answer.
  assert.deepEqual(userMessageItem("u1", "hi").content, [{ type: "text", text: "hi", text_elements: [] }]);
  const agent = agentMessageItem("a1", "yo");
  assert.equal(agent.text, "yo");
  assert.equal(agent.content, undefined);
  assert.equal(agent.phase, null);
});

test("a tool that reports a timeline event still closes its card", () => {
  // read/grep/edit emit file_read/grep/file_diff INSTEAD of tool_use_completed,
  // so a bridge that only watches for the generic completion leaves those cards
  // spinning forever — which is exactly what the client showed.
  for (const [tool, type] of [["read", "file_read"], ["grep", "grep"], ["edit", "file_diff"]]) {
    const seen = [];
    const onEvent = createItemBridge((m, p) => seen.push([m, p]));
    onEvent({ type: "tool_use_started", tool_use_id: "t1", tool_name: tool, args_preview: '{"filePath":"a.py","pattern":"x"}' });
    onEvent({ type, tool_use_id: "t1", tool_name: tool, path: "a.py" });
    assert.deepEqual(seen.map(([m]) => m), ["item/started", "item/completed"], `${tool} closes its card`);
    assert.equal(seen[0][1].item.id, seen[1][1].item.id);
    assert.equal(seen[1][1].item.status, "completed");
  }
});

test("a single-argument tool call still renders its argument", () => {
  // The loop's previewArgs collapses a lone string argument to the bare value,
  // so a read arrives as `calc.py` rather than JSON — which rendered as `cat `
  // with nothing after it.
  const seen = [];
  const onEvent = createItemBridge((m, p) => seen.push([m, p]));
  onEvent({ type: "tool_use_started", tool_use_id: "t1", tool_name: "read", args_preview: "calc.py" });
  assert.equal(seen[0][1].item.command, "cat calc.py");

  const seen2 = [];
  const onEvent2 = createItemBridge((m, p) => seen2.push([m, p]));
  onEvent2({ type: "tool_use_started", tool_use_id: "t2", tool_name: "grep", args_preview: "add(" });
  assert.equal(seen2[0][1].item.command, 'rg "add("');
});
