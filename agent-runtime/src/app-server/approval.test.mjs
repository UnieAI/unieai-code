// Approvals are the one place where a lost message must not turn into a command
// running unasked, so every failure path here is checked to refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEngineDecision, commandArgv, createApprovalBridge } from "./approval.mjs";

test("only an explicit approval approves", () => {
  assert.equal(toEngineDecision("approved"), "accept");
  assert.equal(toEngineDecision("approved_for_session"), "acceptForSession");
  for (const no of ["denied", "abort", "timed_out", undefined, null, "", "yes", { approved_execpolicy_amendment: {} }]) {
    assert.equal(toEngineDecision(no), "decline", `${JSON.stringify(no)} must not approve`);
  }
});

test("the command is shown as what will actually run", () => {
  // Inventing a tokenisation would render something the shell would not execute.
  assert.deepEqual(commandArgv("ls -la | head"), ["sh", "-lc", "ls -la | head"]);
  assert.deepEqual(commandArgv(""), []);
  assert.deepEqual(commandArgv(undefined), []);
});

test("a command approval asks the command question", async () => {
  const asked = [];
  const approve = createApprovalBridge({
    request: async (method, params) => { asked.push([method, params]); return { decision: "approved" }; },
    cwd: "/repo",
  });
  assert.equal(await approve({ tool: "bash", action: "run it", detail: "rm -rf build" }), "accept");
  const [method, params] = asked[0];
  assert.equal(method, "item/commandExecution/requestApproval");
  assert.deepEqual(params.command, ["sh", "-lc", "rm -rf build"]);
  assert.equal(params.cwd, "/repo");
  assert.equal(params.reason, "run it");
});

test("an edit asks the file-change question instead", async () => {
  const asked = [];
  const approve = createApprovalBridge({
    request: async (method, params) => { asked.push([method, params]); return { decision: "approved" }; },
  });
  await approve({ tool: "edit", detail: "src/a.py" });
  assert.equal(asked[0][0], "item/fileChange/requestApproval");
  assert.equal(asked[0][1].path, "src/a.py");
});

test("a refusal, a timeout and an abort all decline", async () => {
  for (const decision of ["denied", "timed_out", "abort"]) {
    const approve = createApprovalBridge({ request: async () => ({ decision }) });
    assert.equal(await approve({ tool: "bash", detail: "x" }), "decline");
  }
});

test("a client that errors declines rather than proceeding", async () => {
  const approve = createApprovalBridge({ request: async () => { throw new Error("socket gone"); } });
  assert.equal(await approve({ tool: "bash", detail: "rm -rf /" }), "decline");
});

test("a malformed answer declines", async () => {
  const approve = createApprovalBridge({ request: async () => ({}) });
  assert.equal(await approve({ tool: "bash", detail: "x" }), "decline");
});

test("each request carries its own call id", async () => {
  const ids = [];
  const approve = createApprovalBridge({ request: async (_m, p) => { ids.push(p.callId); return { decision: "denied" }; } });
  await approve({ tool: "bash", detail: "a" });
  await approve({ tool: "bash", detail: "b" });
  assert.equal(new Set(ids).size, 2, "ids are distinct so answers cannot be crossed");
});
