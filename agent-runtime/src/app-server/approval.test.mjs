// The approval round trip, against the enums and params the Rust side actually
// defines (codex-rs/app-server-protocol/src/protocol/v2/item.rs).
//
// This used to compare against the CORE vocabulary (`approved`), which the wire
// never sends, and to omit every required param — so the request failed to
// deserialize, the client answered with an error, and the error was read as a
// refusal. Every approval was silently declined and the user was never asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toEngineDecision, commandText, createApprovalBridge } from "./approval.mjs";

const IDS = { threadId: "th_1", turnId: "tu_1" };

test("the v2 decisions map to the engine's", () => {
  assert.equal(toEngineDecision("accept"), "accept");
  assert.equal(toEngineDecision("acceptForSession"), "acceptForSession");
  assert.equal(toEngineDecision("decline"), "decline");
  assert.equal(toEngineDecision("cancel"), "decline");
});

test("the core vocabulary is NOT accepted — it is not what the wire sends", () => {
  // Keeping this explicit: if someone reintroduces `approved`, the bug it
  // caused was invisible in every other test.
  assert.equal(toEngineDecision("approved"), "decline");
  assert.equal(toEngineDecision("approved_for_session"), "decline");
});

test("an amendment variant is still an approval", () => {
  // The user said yes; we simply do not implement the policy change that came
  // with it. Reading it as a refusal would override them.
  assert.equal(toEngineDecision({ acceptWithExecpolicyAmendment: { execpolicyAmendment: {} } }), "accept");
  assert.equal(toEngineDecision({ applyNetworkPolicyAmendment: { networkPolicyAmendment: {} } }), "accept");
});

test("anything unrecognised is a refusal", () => {
  for (const d of [undefined, null, "", "yes", 42, {}]) {
    assert.equal(toEngineDecision(d), "decline", `${JSON.stringify(d)} was not refused`);
  }
});

test("the command is a string, as the type says", () => {
  assert.equal(commandText("pytest -q"), "pytest -q");
  assert.equal(commandText("  "), null);
  assert.equal(commandText(undefined), null);
});

test("a command approval carries every field the client routes by", async () => {
  let sent = null;
  const ask = createApprovalBridge({
    request: async (method, params) => { sent = { method, params }; return { decision: "accept" }; },
    cwd: "/w",
    ids: () => IDS,
  });

  assert.equal(await ask({ tool: "bash", action: "run outside the sandbox", detail: "rm -rf build" }), "accept");
  assert.equal(sent.method, "item/commandExecution/requestApproval");
  for (const key of ["threadId", "turnId", "itemId", "startedAtMs"]) {
    assert.ok(sent.params[key] != null, `${key} is missing — the client cannot place this request`);
  }
  assert.equal(sent.params.command, "rm -rf build");
  assert.equal(sent.params.cwd, "/w");
});

test("a file change goes to the fileChange method, with its own fields", async () => {
  let sent = null;
  const ask = createApprovalBridge({
    request: async (method, params) => { sent = { method, params }; return { decision: "acceptForSession" }; },
    ids: () => IDS,
  });

  assert.equal(await ask({ tool: "fs", kind: "read_only_write", action: "write to a.txt", detail: "/w/a.txt" }), "acceptForSession");
  assert.equal(sent.method, "item/fileChange/requestApproval");
  assert.equal(sent.params.threadId, "th_1");
  assert.equal(sent.params.grantRoot, null);
  // `path` and `command` are not fields of this type; sending them is how the
  // request stopped deserializing in the first place.
  assert.ok(!("path" in sent.params));
  assert.ok(!("command" in sent.params));
});

test("with no turn to attribute it to, nothing is asked and nothing runs", async () => {
  let called = false;
  const ask = createApprovalBridge({
    request: async () => { called = true; return { decision: "accept" }; },
    ids: () => ({ threadId: "th_1", turnId: null }),
  });
  assert.equal(await ask({ tool: "bash", detail: "ls" }), "decline");
  assert.equal(called, false, "an unplaceable request was sent anyway");
});

test("a client that errors, or vanishes, is a refusal", async () => {
  const boom = createApprovalBridge({ request: async () => { throw new Error("closed"); }, ids: () => IDS });
  assert.equal(await boom({ tool: "bash", detail: "ls" }), "decline");

  const silent = createApprovalBridge({ request: async () => ({}), ids: () => IDS });
  assert.equal(await silent({ tool: "bash", detail: "ls" }), "decline");
});

test("each request gets its own ids", async () => {
  const seen = [];
  const ask = createApprovalBridge({
    request: async (_m, params) => { seen.push(params.itemId); return { decision: "decline" }; },
    ids: () => IDS,
  });
  await ask({ tool: "bash", detail: "one" });
  await ask({ tool: "bash", detail: "two" });
  assert.equal(new Set(seen).size, 2, "two approvals shared an item id");
});
