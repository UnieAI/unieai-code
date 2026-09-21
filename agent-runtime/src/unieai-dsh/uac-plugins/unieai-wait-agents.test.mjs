// Copyright (c) 2026 UnieAI. All rights reserved.
// wait_agents holds the whole session while it runs, so every way it can fail
// to notice a child has finished costs the user the wait in full.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, childTurnState, createChildRegistry, waitForChildren } from "./unieai-wait-agents.mjs";

/** A child agent whose session log says its turn ended. */
const finishedAgent = (text = "done") => ({
  status: "idle",
  session: {
    snapshotEvents: () => [
      { seq: 1, type: "turn/start" },
      { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } },
      { seq: 3, type: "turn/end", data: { reason: { kind: "completed" } } },
    ],
  },
});

test("a child whose agent is gone settles instead of being waited out", async () => {
  const registry = createChildRegistry();
  registry.started("parent", { id: "child" });
  // What the plugin's refresh does: the agent has been disposed, so there is
  // nothing left to inspect and `subagent/end` never came.
  let missingSince = null;
  const refresh = () => {
    for (const child of registry.children("parent")) {
      if (!child.running) continue;
      missingSince ??= Date.now();
      if (Date.now() - missingSince >= 20) registry.ended("parent", { id: child.id, stopReason: "completed" });
    }
  };

  const started = Date.now();
  const value = await waitForChildren(registry, "parent", { agent_ids: ["child"], timeout_ms: 5_000 }, { refresh, pollMs: 5 });
  assert.ok(Date.now() - started < 1_000, "settled from the grace period, not the timeout");
  assert.equal(value.timed_out, false);
  assert.deepEqual(
    value.children.map((child) => [child.agent_id, child.status]),
    [["child", "finished"]],
  );
});

test("a finished child is read from its own session log", () => {
  assert.deepEqual(childTurnState(finishedAgent("all set")), {
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "all set" }],
  });
  // Still working: no turn/end after the boundary.
  assert.equal(childTurnState({ status: "idle", session: { snapshotEvents: () => [{ seq: 1, type: "turn/start" }] } }), null);
  assert.equal(childTurnState(undefined), null, "a disposed agent cannot be read");
});

test("a cancelled wait says what cancelled it, whatever shape the reason has", async () => {
  const registry = createChildRegistry();
  registry.started("parent", { id: "child" });
  const controller = new AbortController();
  // dsh aborts with a reason that is not an Error; thrown as-is it reached
  // the model as "Error: [object Object]".
  setTimeout(() => controller.abort({ kind: "interrupted" }), 10);
  await assert.rejects(
    () => waitForChildren(registry, "parent", { agent_ids: ["child"] }, { signal: controller.signal, pollMs: 5 }),
    (error) => error instanceof Error && !error.message.includes("[object Object]") && error.message.includes("interrupted"),
  );
});

test("the wait is short enough that a typed message is not left sitting for minutes", () => {
  assert.ok(DEFAULTS.defaultTimeoutMs <= 60_000, `default hold is ${DEFAULTS.defaultTimeoutMs}ms`);
  assert.ok(DEFAULTS.maxTimeoutMs <= 180_000, `a caller can ask to hold for ${DEFAULTS.maxTimeoutMs}ms`);
});
