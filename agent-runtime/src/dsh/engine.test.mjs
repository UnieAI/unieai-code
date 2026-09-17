// The uac engine against an in-memory ACP agent that speaks what dsh's
// `--profile acp` sends (packages/acp/acp/src/updates.ts in deepseek-harness).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createAcpConnection } from "./acp-client.mjs";
import {
  createDshEngine,
  createDshHost,
  diffFromArgs,
  engineToolArgs,
  findModelOption,
  historyTurn,
  newSessionWhenRoutesReady,
} from "./engine.mjs";
import { permissionMode, pickDefaultModel, renderCredentials, renderPatch, renderSettings } from "./config.mjs";

/** A fake agent: `script(request, agent)` answers each client request. */
function fakeAgent(script) {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const client = createAcpConnection({ input: toClient, output: toAgent });
  const agent = createAcpConnection({ input: toAgent, output: toClient });
  const calls = [];
  for (const method of ["session/new", "session/resume", "session/prompt", "session/set_config_option", "session/close"]) {
    agent.onRequest(method, (params) => {
      calls.push({ method, params });
      return script({ method, params }, agent);
    });
  }
  agent.onNotification("session/cancel", (params) => calls.push({ method: "session/cancel", params }));
  return { client, agent, calls };
}

const MODEL_OPTIONS = [
  {
    id: "model",
    type: "select",
    currentValue: JSON.stringify(["unieai", "GLM-5.2"]),
    options: [
      { group: "unieai", name: "UnieAI", options: [
        { value: JSON.stringify(["unieai", "GLM-5.2"]), name: "GLM-5.2" },
        { value: JSON.stringify(["unieai", "MiniMax-M2"]), name: "MiniMax-M2" },
      ] },
    ],
  },
];

const update = (agent, sessionId, body) => agent.notify("session/update", { sessionId, update: body });

test("a turn streams text and thoughts and maps tool calls to engine events", async () => {
  const { client, calls } = fakeAgent(async ({ method, params }, agent) => {
    if (method === "session/new") return { sessionId: "s1", configOptions: MODEL_OPTIONS };
    if (method === "session/set_config_option") return { configOptions: MODEL_OPTIONS };
    if (method === "session/prompt") {
      update(agent, params.sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "m", content: { type: "text", text: "thinking" } });
      update(agent, params.sessionId, { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "other", status: "in_progress", rawInput: { command: "ls" } });
      update(agent, params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.txt" } }] });
      update(agent, params.sessionId, { sessionUpdate: "tool_call", toolCallId: "c2", title: "edit", kind: "other", status: "in_progress", rawInput: { file_path: "a.txt", old_string: "x", new_string: "y" } });
      update(agent, params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", content: [] });
      update(agent, params.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "done" } });
      return { stopReason: "end_turn" };
    }
    return {};
  });
  const host = createDshHost({ connect: async () => client });
  const text = [];
  const reasoning = [];
  const events = [];
  const engine = createDshEngine({
    host,
    workspace: "/w",
    model: "MiniMax-M2",
    onText: (t) => text.push(t),
    onReasoning: (t) => reasoning.push(t),
    onToolEvent: (e) => events.push(e),
  });

  const result = await engine.send("hello");

  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(text, ["done"]);
  assert.deepEqual(reasoning, ["thinking"]);
  assert.deepEqual(calls[0], { method: "session/new", params: { cwd: "/w", mcpServers: [] } });
  assert.deepEqual(calls[1].params, { sessionId: "s1", configId: "model", value: JSON.stringify(["unieai", "MiniMax-M2"]) });
  assert.deepEqual(
    events.map((e) => [e.type, e.tool_name]),
    [["tool_use_started", "bash"], ["tool_use_completed", "bash"], ["tool_use_started", "edit"], ["file_diff", "edit"]],
  );
  assert.equal(events[0].args.cmd, "bash -lc ls");
  assert.equal(events[1].output_preview, "a.txt");
  assert.equal(events[2].diff, events[3].diff, "the started card already carries the change");
  assert.equal(events[3].path, "a.txt");
  assert.match(events[3].diff, /^-x$/m);
  assert.match(events[3].diff, /^\+y$/m);
  assert.deepEqual(engine.messages, [{ role: "user", content: "hello" }, { role: "assistant", content: "done" }]);
});

test("permission requests go through requestApproval and fail closed", async () => {
  const decisions = ["decline", "acceptForSession"];
  const asked = [];
  const outcomes = [];
  const { client } = fakeAgent(async ({ method, params }, agent) => {
    if (method === "session/new") return { sessionId: "s2", configOptions: [] };
    if (method === "session/prompt") {
      for (const id of ["c1", "c2", "c3"]) {
        update(agent, params.sessionId, { sessionUpdate: "tool_call", toolCallId: id, title: "bash", kind: "other", status: "in_progress", rawInput: { command: `rm ${id}` } });
        const { outcome } = await agent.request("session/request_permission", {
          sessionId: params.sessionId,
          toolCall: { toolCallId: id },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        });
        outcomes.push(outcome.optionId);
      }
      return { stopReason: "end_turn" };
    }
    return {};
  });
  const host = createDshHost({ connect: async () => client });
  const engine = createDshEngine({
    host,
    workspace: "/w",
    requestApproval: async (request) => {
      asked.push(request.detail);
      return decisions.shift();
    },
  });

  await engine.send("clean up");

  // Declined, then approved for the session, then not asked again.
  assert.deepEqual(asked, ["rm c1", "rm c2"]);
  assert.deepEqual(outcomes, ["reject-once", "allow-once", "allow-once"]);
});

test("aborting a turn sends session/cancel", async () => {
  const controller = new AbortController();
  let release;
  const { client, calls } = fakeAgent(async ({ method }) => {
    if (method === "session/new") return { sessionId: "s3", configOptions: [] };
    if (method === "session/prompt") {
      controller.abort();
      await new Promise((resolve) => { release = resolve; setTimeout(resolve, 50); });
      return { stopReason: "cancelled" };
    }
    return {};
  });
  const host = createDshHost({ connect: async () => client });
  const engine = createDshEngine({ host, workspace: "/w" });

  const result = await engine.send("long job", { abortSignal: controller.signal });

  assert.equal(result.stopReason, "cancelled");
  assert.ok(calls.some((c) => c.method === "session/cancel" && c.params.sessionId === "s3"));
  release?.();
});

test("helpers: args, diffs, model options, config rendering", () => {
  assert.deepEqual(engineToolArgs("read", { file_path: "x.py", offset: 3 }), { file_path: "x.py", offset: 3, filePath: "x.py" });
  assert.deepEqual(engineToolArgs("bash", "raw"), { __raw: "raw" });
  assert.equal(engineToolArgs("bash", { command: "cd a && wc -l 'x y'" }).cmd, `bash -lc 'cd a && wc -l '\\''x y'\\'''`);

  const write = diffFromArgs("write", { file_path: "n.txt", content: "a\nb\n" });
  assert.equal(write.kind, "add");
  assert.equal(write.diff, "a\nb\n");
  const update = diffFromArgs("edit", { file_path: "m.txt", old_string: "a\nb", new_string: "c" });
  assert.equal(update.diff, "--- a/m.txt\n+++ b/m.txt\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n");
  assert.equal(diffFromArgs("bash", { command: "ls" }), null);

  assert.equal(findModelOption(MODEL_OPTIONS, "GLM-5.2"), JSON.stringify(["unieai", "GLM-5.2"]));
  assert.equal(findModelOption(MODEL_OPTIONS, "nope"), null);

  const settings = renderSettings({ baseUrl: "https://gw/v1", models: ["A", "B"], defaultModel: "A" });
  assert.match(settings, /baseURL: "https:\/\/gw\/v1"/);
  assert.match(settings, /- id: "B"/);
  assert.match(settings, /agent-default-model:\n {2}provider: unieai\n {2}model: "A"/);
  assert.equal(renderPatch({ defaultModel: "A" }), '- id: acp\n  config:\n    provider: unieai\n    model: "A"\n');
  assert.match(
    renderPatch({ defaultModel: "A", controlSocket: "/s/c.sock", pluginUrl: "file:///p/uac-control.mjs" }),
    /- insert:\n {4}- id: uac-control\n {6}name: "file:\/\/\/p\/uac-control.mjs"\n {6}config:\n {8}socket: "\/s\/c.sock"/,
  );

  assert.equal(pickDefaultModel({ explicit: "X", configured: "A", listed: ["B"] }), "X");
  assert.equal(pickDefaultModel({ configured: "GLM-5.2", listed: ["B", "C"] }), "B");
  assert.equal(pickDefaultModel({ configured: "C", listed: ["B", "C"] }), "C");
  assert.equal(pickDefaultModel({ configured: "C", listed: [] }), "C");

  assert.equal(permissionMode("readOnly"), "read-only");
  assert.equal(permissionMode(undefined), "workspace-write");
});

test("session/new is retried while dsh is still registering providers", async () => {
  let attempts = 0;
  const acp = {
    async request(method) {
      assert.equal(method, "session/new");
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("Internal error"), { data: { details: 'no adapter registered for provider "unieai"' } });
      }
      return { sessionId: "late" };
    },
  };
  const created = await newSessionWhenRoutesReady(acp, {}, { intervalMs: 1 });
  assert.equal(created.sessionId, "late");
  assert.equal(attempts, 3);

  const broken = { request: async () => { throw new Error("disk full"); } };
  await assert.rejects(newSessionWhenRoutesReady(broken, {}, { intervalMs: 1 }), /disk full/);
});

test("the gateway key goes to dsh's credential store, quoted", () => {
  assert.equal(renderCredentials({ apiKey: "sk-1:2" }), 'version: 1\n\nrefs:\n  UNIEAI_GATEWAY_API_KEY: "sk-1:2"\n');
});

/** A host whose ACP side is the fake agent and whose control side is scripted. */
function scriptedHost(client, control) {
  const host = createDshHost({ connect: async () => client, connectControl: async () => ({ request: control, close() {} }) });
  return host;
}

test("fork, revert and history go through the control channel; revert reopens the trimmed copy", async () => {
  const controlCalls = [];
  const acpCalls = [];
  const { client } = fakeAgent(async ({ method, params }) => {
    acpCalls.push([method, params.sessionId]);
    if (method === "session/new") return { sessionId: "s1", configOptions: [] };
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  });
  const control = async (method, params) => {
    controlCalls.push([method, params]);
    if (method === "fork") return { sessionId: `child-of-${params.sessionId}`, keptTurns: params.keepTurns ?? 2 };
    if (method === "history") return { turns: [{ startedAt: 1, completedAt: 2, endSeq: 5, reason: "completed", items: [{ type: "user", text: "hi" }] }] };
    return {};
  };
  const host = scriptedHost(client, control);
  const states = [];
  const engine = createDshEngine({ host, workspace: "/w", onState: (s) => states.push(s) });

  assert.deepEqual(await engine.history(), [], "no session yet, no history");
  assert.deepEqual(await engine.fork({ keepTurns: 1 }), { state: null, keptTurns: 0 });
  await engine.send("hi");
  assert.deepEqual(states, [{ sessionId: "s1" }]);

  assert.deepEqual(await engine.fork({ keepTurns: 1 }), { state: { sessionId: "child-of-s1" }, keptTurns: 1 });
  const history = await engine.history();
  assert.equal(history[0].status, "completed");
  assert.equal(history[0].items[0].type, "userMessage");

  await engine.revert({ keepTurns: 0 });
  assert.deepEqual(states.at(-1), { sessionId: "child-of-s1" });
  assert.ok(acpCalls.some(([m, id]) => m === "session/close" && id === "s1"), "the old session is closed first");
  assert.deepEqual(controlCalls.map(([m]) => m), ["fork", "history", "fork"]);
  await engine.send("after revert");
  assert.deepEqual(acpCalls.filter(([m]) => m === "session/resume"), [["session/resume", "child-of-s1"]]);
});

test("a stored conversation is resumed, not recreated", async () => {
  const calls = [];
  const { client } = fakeAgent(async ({ method, params }) => {
    calls.push([method, params.sessionId]);
    if (method === "session/prompt") return { stopReason: "end_turn" };
    return {};
  });
  const host = createDshHost({ connect: async () => client });
  const states = [];
  const engine = createDshEngine({ host, workspace: "/w", resumeState: { sessionId: "old" }, onState: (s) => states.push(s) });
  await engine.send("again");
  assert.deepEqual(calls.map(([m]) => m), ["session/resume", "session/prompt"]);
  assert.equal(calls[1][1], "old");
  assert.deepEqual(states, [], "the conversation did not change identity");
});

test("steer only reaches dsh while a turn is running", async () => {
  const steers = [];
  let finish;
  const { client } = fakeAgent(async ({ method }) => {
    if (method === "session/new") return { sessionId: "s9", configOptions: [] };
    if (method === "session/prompt") return new Promise((resolve) => { finish = () => resolve({ stopReason: "end_turn" }); });
    return {};
  });
  const host = scriptedHost(client, async (method, params) => {
    steers.push([method, params]);
    return { delivered: true };
  });
  const engine = createDshEngine({ host, workspace: "/w" });
  assert.equal(await engine.steer("too early"), false);
  const turn = engine.send("work");
  while (!finish) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await engine.steer("now"), true);
  finish();
  await turn;
  assert.deepEqual(steers, [["steer", { sessionId: "s9", text: "now" }]]);
});

test("history turns become protocol items with tool cards", () => {
  const turn = historyTurn({
    startedAt: 10,
    completedAt: 20,
    endSeq: 9,
    reason: "aborted",
    items: [
      { type: "user", text: "fix" },
      { type: "reasoning", text: "thinking" },
      { type: "tool", name: "bash", arguments: '{"command":"ls"}', status: "completed", output: "a" },
      { type: "tool", name: "write", arguments: '{"file_path":"n.txt","content":"x\\n"}', status: "completed", output: "" },
      { type: "tool", name: "bash", arguments: "not json", status: "failed", output: "boom" },
      { type: "assistant", text: "done" },
    ],
  });
  assert.equal(turn.status, "interrupted");
  assert.deepEqual(turn.items.map((i) => i.type), ["userMessage", "reasoning", "commandExecution", "fileChange", "commandExecution", "agentMessage"]);
  assert.equal(turn.items[2].command, "bash -lc ls");
  assert.equal(turn.items[2].aggregatedOutput, "a");
  assert.deepEqual(turn.items[3].changes[0].kind, { type: "add" });
  assert.equal(turn.items[4].status, "failed");
  assert.equal(historyTurn({ endSeq: null, items: [] }).status, "inProgress");
});
