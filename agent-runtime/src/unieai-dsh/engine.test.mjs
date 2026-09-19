// Copyright (c) 2026 UnieAI. All rights reserved.
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
import { configuredUacMode, parseUacMode, permissionMode, pickDefaultModel, renderCredentials, renderPatch, renderSettings, selectPlugins } from "./config.mjs";

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
  assert.equal(engineToolArgs("exec_command", { cmd: "make test", yield_time_ms: 1000 }).cmd, "bash -lc 'make test'");
  assert.equal(engineToolArgs("write_stdin", { session_id: 7, chars: "" }).cmd, "poll session 7");
  assert.equal(engineToolArgs("write_stdin", { session_id: 7, chars: "\u0003" }).cmd, "interrupt session 7");
  assert.equal(engineToolArgs("bash", { command: "cd a && wc -l 'x y'" }).cmd, `bash -lc 'cd a && wc -l '\\''x y'\\'''`);

  const write = diffFromArgs("write", { file_path: "n.txt", content: "a\nb\n" });
  assert.equal(write.kind, "add");
  assert.equal(write.diff, "a\nb\n");
  const update = diffFromArgs("edit", { file_path: "m.txt", old_string: "a\nb", new_string: "c" });
  assert.equal(update.diff, "--- a/m.txt\n+++ b/m.txt\n@@ -1,2 +1,1 @@\n-a\n-b\n+c\n");
  assert.equal(diffFromArgs("bash", { command: "ls" }), null);

  assert.equal(findModelOption(MODEL_OPTIONS, "GLM-5.2"), JSON.stringify(["unieai", "GLM-5.2"]));
  assert.equal(findModelOption(MODEL_OPTIONS, "nope"), null);

  const settings = renderSettings({
    baseUrl: "https://gw/v1",
    models: ["A", { id: "B", context_window: 64000, input_modalities: ["text", "image", "video"] }],
    defaultModel: "A",
  });
  assert.match(settings, /- id: "A"\n {8}- id: "B"\n {10}contextWindow: 64000\n {10}input: \[text, image\]/);
  assert.match(settings, /defaultContextWindow: 128000/);
  assert.match(settings, /retryableCodes: \[[^\]]*STREAM_CLOSED/);
  assert.match(settings, /shell:\n {2}timeoutMs: 300000/);
  assert.match(settings, /baseURL: "https:\/\/gw\/v1"/);
  assert.match(settings, /- id: "B"/);
  assert.match(settings, /agent-default-model:\n {2}provider: unieai\n {2}model: "A"/);
  const base = renderPatch({ defaultModel: "A" });
  assert.ok(base.startsWith('- id: acp\n  config:\n    provider: unieai\n    model: "A"\n'));
  assert.match(base, /- id: system-prompt\n {2}config:\n {4}includeHarnessIdentity: false/);
  assert.match(base, /personaPrefix: \|\n {6}You are UnieAI Code/);
  assert.doesNotMatch(base.replace(/\{\{(model|cwd)\}\}/g, ""), /\{\{/, "dsh interpolates strictly");
  assert.doesNotMatch(renderPatch({ defaultModel: "A", acp: false }), /- id: acp\n/);
  assert.doesNotMatch(renderPatch({ defaultModel: "A", persona: false }), /system-prompt/);
  const withExec = renderPatch({
    defaultModel: "A",
    plugins: selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-exec" }),
  });
  assert.match(withExec, /- id: tool-bash\n {2}disabled: true/);
  assert.match(withExec, / {4}- id: unieai-exec\n {6}name: "file:\/\/.*uac-plugins\/unieai-exec\.mjs"/);
  assert.match(withExec, /exec_command/, "the persona teaches the tools that are loaded");
  assert.doesNotMatch(base, /exec_command/);
  assert.match(
    renderPatch({ defaultModel: "A", controlSocket: "/s/c.sock", pluginUrl: "file:///p/unieai-control.mjs" }),
    /- insert:\n {4}- id: unieai-control\n {6}name: "file:\/\/\/p\/unieai-control.mjs"\n {6}config:\n {8}socket: "\/s\/c.sock"/,
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
  assert.equal(renderCredentials({ apiKey: "sk-1:2" }), 'version: 1\n\nrefs:\n  UNIEAI_GATEWAY_API_KEY: "sk-1:2"\n  UNIEAI_LOCAL_API_KEY: "local"\n');
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
    // Token usage is read after every turn; it is not what this test is about.
    if (method !== "usage") controlCalls.push([method, params]);
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
    if (method !== "usage") steers.push([method, params]);
    return { delivered: true };
  });
  const engine = createDshEngine({ host, workspace: "/w" });
  assert.equal(await engine.steer("too early"), false);
  const turn = engine.send("work");
  while (!finish) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await engine.steer("now"), true);
  finish();
  await turn;
  assert.deepEqual(steers, [["steer", { sessionId: "s9", text: "now", clientId: null }]]);
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

test("uac loads the vendored uac-plugins cli profile; UNIEAI_DSH_PLUGINS narrows it", () => {
  const ids = selectPlugins({}).map((p) => p.id);
  for (const id of ["unieai-exec", "unieai-toolcall-repair", "unieai-loop-guard", "unieai-loop-completion"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(selectPlugins({ UNIEAI_DSH_PLUGINS: "off" }), []);
  assert.deepEqual(selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-missing" }), []);
  assert.deepEqual(selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-loop-guard" }).map((p) => p.id), ["unieai-loop-guard"]);
  // Budgets stay env-driven and the doom guard off in the CLI.
  const patch = renderPatch({ defaultModel: "A", plugins: selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-loop-guard" }) });
  assert.match(patch, / {4}- id: unieai-loop-guard\n {6}name: "file:[^"]+"\n {6}config:\n {8}doom: false/);
  assert.doesNotMatch(patch, /repeat-tool-reminder/);
});

test("a text-only default model gets a vision model of its own family", async () => {
  const { pickVisionModel } = await import("./config.mjs");
  const catalog = [
    { id: "DeepSeek-V4-Flash-0731", input_modalities: ["text"] },
    { id: "Qwen3.6-35B-A3B", input_modalities: ["text", "image"] },
    { id: "DeepSeek-V4-Flash-Vision-Exp", input_modalities: ["text", "image"] },
  ];
  assert.equal(pickVisionModel(catalog, "DeepSeek-V4-Flash-0731"), "DeepSeek-V4-Flash-Vision-Exp");
  assert.equal(pickVisionModel(catalog, "Qwen3.6-35B-A3B"), null, "it can see images itself");
  assert.equal(pickVisionModel([{ id: "t", input_modalities: ["text"] }], "t"), null);
  const patch = renderPatch({ defaultModel: "A", gatewayBaseUrl: "https://gw/v1", visionModel: "V", plugins: selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-vision-fallback" }) });
  assert.match(patch, / {4}- id: unieai-vision-fallback\n {6}name: "file:[^"]+"\n {6}config:\n {8}gatewayBaseUrl: "https:\/\/gw\/v1"\n {8}visionModel: "V"/);
});

test("AGENTS.md and skills come from the UnieAI home", () => {
  const patch = renderPatch({ defaultModel: "A", home: "/h/.unieai", plugins: selectPlugins({ UNIEAI_DSH_PLUGINS: "unieai-skills" }) });
  assert.match(patch, /- id: agent-instructions\n {2}config:\n {4}maxBytes: 65536\n {4}dshHome: "\/h\/\.unieai"/);
  assert.match(patch, /- id: skill-filesystem\n {2}disabled: true/);
  assert.match(patch, / {4}- id: unieai-skills\n {6}name: "file:[^"]+"\n {6}config:\n {8}home: "\/h\/\.unieai"/);
});

test("apply_patch calls render as a diff of the first file they change", async () => {
  const { diffFromApplyPatch } = await import("./engine.mjs");
  const update = diffFromApplyPatch("*** Begin Patch\n*** Update File: src/a.py\n@@ def f():\n-    return 1\n+    return 2\n*** Add File: b.txt\n+x\n*** End Patch");
  assert.equal(update.path, "src/a.py");
  assert.equal(update.kind, "update");
  assert.equal(update.diff, "--- a/src/a.py\n+++ b/src/a.py\n@@ -1,1 +1,1 @@\n-    return 1\n+    return 2\n");
  const add = diffFromApplyPatch("*** Begin Patch\n*** Add File: n.txt\n+hello\n+world\n*** End Patch");
  assert.deepEqual(add, { path: "n.txt", kind: "add", diff: "hello\nworld\n" });
  assert.equal(diffFromApplyPatch("nonsense"), null);
});

test("a dying agent's own error is what gets reported", async () => {
  const { agentFailureReason } = await import("./acp-client.mjs");
  assert.equal(
    agentFailureReason([
      "file:///x/profile-boot.js:1",
      "import { watchUserPatches } from '@deepseek-ai/dsh-app-boot';",
      "        ^",
      "SyntaxError: The requested module '@deepseek-ai/dsh-app-boot' does not provide an export named 'watchUserPatches'",
      "    at ModuleJob._instantiate (node:internal/modules/esm/module_job:226:21)",
      "Node.js v22.23.2",
    ]),
    "SyntaxError: The requested module '@deepseek-ai/dsh-app-boot' does not provide an export named 'watchUserPatches'",
  );
  assert.equal(agentFailureReason(["", "just stopped"]), "just stopped");
  assert.equal(agentFailureReason([]), null);
});

test("terminal cards show the command's output and exit code, not the model-facing header", async () => {
  const { terminalView } = await import("./engine.mjs");
  const text = "Chunk ID: 926d2c\nWall time: 0.2580 seconds\nProcess exited with code 1\nOriginal token count: 40\nOutput:\nTraceback...\nAssertionError\n";
  assert.deepEqual(terminalView("exec_command", text), { output: "Traceback...\nAssertionError\n", exitCode: 1, running: false });
  const running = "Chunk ID: a\nWall time: 30.0 seconds\nProcess running with session ID 1000\nOriginal token count: 3\nOutput:\nbuilding\n";
  assert.deepEqual(terminalView("write_stdin", running), { output: "building\n", exitCode: null, running: true });
  assert.equal(terminalView("read", text), null, "other tools are left alone");
  assert.equal(terminalView("exec_command", "no header"), null);
});

test("dsh modes: each is a patch on the flat standard composition", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const plugins = selectPlugins({});
  const standard = renderPatch({ defaultModel: "A", plugins });
  assert.equal(renderPatch({ defaultModel: "A", plugins, mode: "standard" }), standard);

  const ptc = renderPatch({ defaultModel: "A", plugins, mode: "ptc" });
  assert.match(ptc, /- id: tools\n {2}config:\n {4}mode: ptc\n/);
  assert.match(ptc, /- id: tool-workflow\n {2}disabled: true/);

  const cordis = renderPatch({ defaultModel: "A", plugins, mode: "cordis" });
  assert.match(cordis, /- id: cordis-host-runner[\s\S]*- id: tool-cordis/, "tool-cordis waits on the host runner");

  const minimal = renderPatch({ defaultModel: "A", plugins, mode: "minimal" });
  for (const id of ["tool-bash", "tool-fs", "tool-subagent", "plan-mode"]) assert.match(minimal, new RegExp(`- id: ${id}\\n {2}disabled: true`));
  assert.match(minimal, /- id: persistent-bash/);
  assert.doesNotMatch(minimal, /unieai-exec|unieai-apply-patch|unieai-web-search/, "no tool plugins in minimal");
  assert.match(minimal, /unieai-loop-guard/, "the loop plugins stay");
  assert.match(minimal, /Your one tool/);
  assert.doesNotMatch(minimal, /todo_write/);

  assert.equal(parseUacMode(" PTC\n"), "ptc");
  assert.equal(parseUacMode("creator"), "cordis");
  assert.equal(parseUacMode("fast"), null);
  const home = mkdtempSync(join(tmpdir(), "uac-mode-"));
  assert.equal(configuredUacMode({ env: {}, home }), "standard");
  mkdirSync(join(home, "uac"));
  writeFileSync(join(home, "uac", "mode"), "minimal\n");
  assert.equal(configuredUacMode({ env: {}, home }), "minimal");
  assert.equal(configuredUacMode({ env: { UNIEAI_UAC_MODE: "ptc" }, home }), "ptc", "the environment wins");
});

test("images: inline for a vision model, a path and describe_image for a text-only one", async () => {
  const { promptContent } = await import("./engine.mjs");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "uac-img-"));
  const png = join(dir, "shot.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const dataUrl = "data:image/jpeg;base64,/9j/AA==";

  const vision = await promptContent("what is this?", [{ path: png }, { url: dataUrl }], { imageInput: true });
  assert.deepEqual(vision, [
    { type: "text", text: "what is this?" },
    { type: "image", mimeType: "image/png", data: "iVBORw==" },
    { type: "image", mimeType: "image/jpeg", data: "/9j/AA==" },
  ]);

  const textOnly = await promptContent("what is this?", [{ path: png }, { url: dataUrl }], { imageInput: false, tmp: dir });
  assert.equal(textOnly.length, 1);
  assert.match(textOnly[0].text, new RegExp(`attached an image: ${png.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. You cannot see images directly; look at it with describe_image`));
  const written = textOnly[0].text.match(/attached an image: (\S+\.jpg)\./)[1];
  assert.deepEqual(readFileSync(written), Buffer.from("/9j/AA==", "base64"), "an inline image is saved for describe_image");

  const missing = await promptContent("x", [{ path: join(dir, "nope.png") }], { imageInput: true });
  assert.match(missing[0].text, /could not be read/);
});

test("local providers: settings declare them with a placeholder key, and their model is the one selected", async () => {
  const { renderSettings, localProviderBaseUrl, fetchLocalModels } = await import("./config.mjs");
  const yaml = renderSettings({ baseUrl: "https://gw/v1", models: [{ id: "A" }], defaultModel: "A", localProviders: [{ id: "ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b"] }] });
  assert.match(yaml, /\n {4}ollama:\n {6}displayName: "Ollama \(local\)"\n {6}apiKeyEnv: UNIEAI_LOCAL_API_KEY\n {6}api: openai-completions\n {6}baseURL: "http:\/\/localhost:11434\/v1"/);
  assert.match(yaml.split("    ollama:")[1], /apiKeyEnv: UNIEAI_LOCAL_API_KEY/, "a placeholder key: dsh refuses a keyless provider");
  assert.equal(localProviderBaseUrl("lmstudio", {}), "http://localhost:1234/v1");
  assert.equal(localProviderBaseUrl("ollama", { CODEX_OSS_PORT: "9999" }), "http://localhost:9999/v1");
  assert.equal(localProviderBaseUrl("ollama", { CODEX_OSS_BASE_URL: "http://box:1/v1/" }), "http://box:1/v1");
  const models = await fetchLocalModels("http://x/v1", { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "qwen3:8b" }, { id: "llama3" }] }) }) });
  assert.deepEqual(models, ["qwen3:8b", "llama3"]);
  const value = (provider, id) => JSON.stringify([provider, id]);
  const options = [{ id: "model", options: [{ value: value("unieai", "qwen3:8b") }, { value: value("ollama", "qwen3:8b") }] }];
  assert.equal(findModelOption(options, "qwen3:8b", "ollama"), value("ollama", "qwen3:8b"));
  assert.equal(findModelOption(options, "qwen3:8b"), value("unieai", "qwen3:8b"));
  const gatewayOnly = [{ id: "model", options: [{ value: value("unieai", "qwen3:8b") }] }];
  assert.equal(findModelOption(gatewayOnly, "qwen3:8b", "ollama"), null, "a local thread never falls back to the gateway's same-named model");
});

test("todo_write becomes the client's plan checklist", async () => {
  const { planFromTodos } = await import("./engine.mjs");
  assert.deepEqual(planFromTodos({ todos: [{ content: "Read calc.py", status: "completed" }, { content: "Add mul", status: "in_progress" }, { content: "Run tests", status: "pending" }] }), [
    { step: "Read calc.py", status: "completed" },
    { step: "Add mul", status: "inProgress" },
    { step: "Run tests", status: "pending" },
  ]);
  assert.deepEqual(planFromTodos('{"todos":[{"content":"x","status":"done"}]}'), [{ step: "x", status: "completed" }]);
  assert.equal(planFromTodos({ other: 1 }), null);
});

test("a command in history shows its output and exit code, not the tool's text", () => {
  const tool = (output) => ({ type: "tool", name: "exec_command", arguments: '{"cmd":"wc -l calc.py"}', status: "completed", output });
  const turn = historyTurn({
    endSeq: 3,
    items: [
      tool("Chunk ID: 37894d\nWall time: 0.2710 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\n10 calc.py\n"),
      tool("Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nno such file\n"),
    ],
  });
  assert.deepEqual(
    turn.items.map((item) => [item.status, item.exitCode, item.aggregatedOutput]),
    [
      ["completed", 0, "10 calc.py\n"],
      ["failed", 2, "no such file\n"],
    ],
  );
});
