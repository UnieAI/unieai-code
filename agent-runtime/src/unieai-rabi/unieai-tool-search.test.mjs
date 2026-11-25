// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import test from "node:test";
// rabi's packages under their upstream names (the ones installed here).
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime, defineTool } from "@deepseek-ai/dsh-tools";
import { renderPatch } from "./config.mjs";
import { TOOL_NAME, apply, describe as describeTool, listDeferred, planDeferral, schemaTokens, searchTools, toolSearchConfig } from "./unieai-tool-search.mjs";

// A server shaped like UnieAI Space: 118 tools, ~85k characters of schema.
const bigServer = Array.from({ length: 118 }, (_, i) => ({
  name: `mcp__space__tool_${String(i).padStart(3, "0")}`,
  description: `Space tool ${i}. ${"Reads and writes records of the space. ".repeat(12)}`,
  parameters: { type: "object", properties: { id: { type: "string", description: "x".repeat(150) } } },
}));
const smallServer = [
  { name: "mcp__unieai_studio__kb_list", description: "List knowledge bases.", parameters: { type: "object", properties: {} } },
  { name: "mcp__unieai_studio__kb_search", description: "Search a knowledge base.", parameters: { type: "object", properties: { q: { type: "string" } } } },
];
const builtin = [
  { name: "exec_command", description: "Run a command.", parameters: { type: "object", properties: {} } },
  { name: TOOL_NAME, description: "static", parameters: { type: "object", properties: { query: { type: "string" } } } },
];

test("the fixture server is as big as the one it stands for", () => {
  const chars = JSON.stringify(bigServer).length;
  assert.ok(chars > 80_000 && chars < 95_000, `${chars}`);
  assert.ok(schemaTokens(bigServer) > 0.1 * 131072);
  assert.ok(schemaTokens(smallServer) < 0.1 * 131072);
});

test("MCP schemas under 10% of the window stay in the tool list and tool_search is left out", () => {
  const plan = planDeferral([...builtin, ...smallServer], { contextWindow: 131072 });
  assert.equal(plan.defer, false);
  assert.deepEqual(plan.kept.map((tool) => tool.name), ["exec_command", ...smallServer.map((tool) => tool.name)]);
});

test("MCP schemas over 10% of the window are deferred; built-ins and loaded tools stay", () => {
  const tools = [...builtin, ...smallServer, ...bigServer];
  const loaded = new Set(["mcp__space__tool_007"]);
  const plan = planDeferral(tools, { contextWindow: 131072, loaded });
  assert.equal(plan.defer, true);
  assert.equal(plan.deferred.length, 118 + 2 - 1);
  assert.deepEqual(plan.kept.map((tool) => tool.name), ["exec_command", TOOL_NAME, "mcp__space__tool_007"]);
  // The share is window-relative: a 1M window takes the same server whole.
  assert.equal(planDeferral(tools, { contextWindow: 1_048_576 }).defer, false);
  // Once deferring, an agent keeps deferring (no flip-flop of the tool list).
  assert.equal(planDeferral([...builtin, ...smallServer], { contextWindow: 131072, sticky: true }).defer, true);
  // deferRatio 0 (UNIEAI_TOOL_SEARCH=on) defers any MCP tool.
  assert.equal(planDeferral([...builtin, ...smallServer], { contextWindow: 131072, deferRatio: 0 }).defer, true);
});

test("the description names every deferred tool, grouped by server", () => {
  assert.equal(listDeferred(smallServer), "mcp__unieai_studio__: kb_list, kb_search");
  const text = describeTool([...smallServer, bigServer[0]]);
  assert.match(text, /3 MCP tools are deferred/);
  assert.match(text, /mcp__space__: tool_000/);
  assert.match(text, /select:/);
});

test("select loads exact or unambiguous short names; keywords rank names over descriptions", () => {
  const tools = [...smallServer, ...bigServer.slice(0, 3)];
  let found = searchTools(tools, "select:mcp__unieai_studio__kb_list, kb_search, tool_001, nope");
  assert.deepEqual(found.matched.map((tool) => tool.name), ["mcp__unieai_studio__kb_list", "mcp__unieai_studio__kb_search", "mcp__space__tool_001"]);
  assert.deepEqual(found.missing, ["nope"]);
  found = searchTools(tools, "knowledge search");
  assert.equal(found.matched[0].name, "mcp__unieai_studio__kb_search");
  found = searchTools(tools, "+records", { maxResults: 2 });
  assert.equal(found.matched.length, 2);
  assert.ok(found.matched.every((tool) => tool.name.startsWith("mcp__space__")));
  assert.deepEqual(searchTools(tools, "zzz").matched, []);
});

test("UNIEAI_TOOL_SEARCH: off, on, auto:<percent>, default", () => {
  assert.equal(toolSearchConfig({ UNIEAI_TOOL_SEARCH: "off" }), null);
  assert.deepEqual(toolSearchConfig({ UNIEAI_TOOL_SEARCH: "on" }), { deferRatio: 0 });
  assert.deepEqual(toolSearchConfig({ UNIEAI_TOOL_SEARCH: "auto:5" }), { deferRatio: 0.05 });
  assert.deepEqual(toolSearchConfig({}), {});
});

function fakeHost() {
  const listeners = new Map();
  const registered = [];
  const logs = [];
  const ctx = {
    on: (event, listener) => listeners.set(event, listener),
    tools: { register: (tool) => registered.push(tool) },
    logger: { info: (line) => logs.push(line) },
    get: () => undefined,
  };
  return { ctx, listeners, registered, logs };
}

const agentWith = (contextWindow) => ({ session: { requestContext: () => ({ provider: "unieai", model: "m", contextWindow }) } });

test("in a host: deferred schemas leave the assembly, tool_search loads them for the next step", async () => {
  const { ctx, listeners, registered } = fakeHost();
  await apply(ctx, {}, { defineTool });
  assert.equal(registered.length, 1);
  const tool = registered[0];
  assert.equal(tool.name, TOOL_NAME);
  const assemble = listeners.get("system-prompt/assemble");
  const agent = agentWith(131072);
  const tools = [...builtin, ...smallServer, ...bigServer];
  const run = () => assemble(null, { agent, scope: agent }, async () => ({ sections: [], contexts: [], variables: {}, tools: structuredClone(tools) }));

  let assembly = await run();
  assert.deepEqual(assembly.tools.map((t) => t.name), ["exec_command", TOOL_NAME]);
  assert.match(assembly.tools[1].description, /120 MCP tools are deferred/);
  assert.ok(schemaTokens(assembly.tools) < 1500, `${schemaTokens(assembly.tools)}`);

  const result = await tool.execute({ query: "select:kb_search,tool_042" }, { agent });
  assert.match(result.text, /Loaded 2 tools/);
  assert.match(result.text, /mcp__space__tool_042/);
  assert.deepEqual(tool.output.render({}, result), [{ type: "text", text: result.text }]);

  assembly = await run();
  assert.deepEqual(assembly.tools.map((t) => t.name), ["exec_command", TOOL_NAME, "mcp__unieai_studio__kb_search", "mcp__space__tool_042"]);
  assert.equal(assembly.tools[2].parameters.properties.q.type, "string");
  assert.match(assembly.tools[1].description, /118 MCP tools are deferred/);

  const again = await tool.execute({ query: "select:tool_042" }, { agent });
  assert.match(again.text, /Already in your tool list/);
  // Bad arguments are refused by rabi's own validation.
  await assert.rejects(tool.execute({}, { agent }));
});

test("in a host: a small MCP server and a big window keep every schema; no tool_search", async () => {
  const { ctx, listeners } = fakeHost();
  await apply(ctx, {}, { defineTool });
  const assemble = listeners.get("system-prompt/assemble");
  const agent = agentWith(131072);
  const assembly = await assemble(null, { agent }, async () => ({ tools: structuredClone([...builtin, ...smallServer]) }));
  assert.deepEqual(assembly.tools.map((t) => t.name), ["exec_command", ...smallServer.map((t) => t.name)]);
  const wide = agentWith(1_048_576);
  const wideAssembly = await assemble(null, { agent: wide }, async () => ({ tools: structuredClone([...builtin, ...bigServer]) }));
  assert.equal(wideAssembly.tools.length, 1 + bigServer.length);
  // No agent (a global preview assembly): untouched.
  const plain = { tools: structuredClone([...builtin, ...bigServer]) };
  assert.equal(await assemble(null, {}, async () => plain), plain);
});

test("on rabi's own prompt and tool services: filtered, loaded, and a deferred tool still runs", async () => {
  const root = new Context();
  root.plugin(SystemPrompt, {});
  root.plugin(ToolRuntime, {});
  const make = (name) =>
    defineTool({
      name,
      description: "Space tool ".repeat(10),
      parameters: { id: { type: "string", description: "x".repeat(600) } },
      output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
      execute: async () => `ran ${name}`,
    });
  root.inject(["tools"], (ctx) => {
    for (let i = 0; i < 118; i += 1) ctx.tools.register(make(`mcp__space__t${i}`));
    ctx.tools.register(make("exec_command"));
  });
  root.plugin({ name: "unieai-tool-search", inject: ["tools"], apply: (ctx) => apply(ctx, {}, { defineTool }) });
  for (let i = 0; i < 50 && !root.tools?.get?.(TOOL_NAME); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const agent = agentWith(131072);
  const names = async () => (await root.systemPrompt.assemble({ agent, scope: agent })).tools.map((tool) => tool.name);
  assert.deepEqual(await names(), ["exec_command", TOOL_NAME]);
  const call = (name, args) => root.tools.execute({ callId: name, name, arguments: args, agent, signal: new AbortController().signal });
  const loaded = await call(TOOL_NAME, { query: "select:t5" });
  assert.equal(loaded.isError, false);
  assert.match(loaded.content[0].text, /Loaded 1 tool/);
  assert.deepEqual(await names(), ["exec_command", "mcp__space__t5", TOOL_NAME]);
  const direct = await call("mcp__space__t9", { id: "a" });
  assert.equal(direct.value, "ran mcp__space__t9");
});

test("the uac patch: compaction is ratio-led and tool search is loaded unless turned off", () => {
  const patch = renderPatch({ defaultModel: "A", plugins: [], persona: false, toolSearch: {} });
  const block = /- id: compaction-basic\n {2}config:\n((?: {4}.+\n)+)/.exec(patch)?.[1] ?? "";
  const config = Object.fromEntries(block.trim().split("\n").map((line) => line.trim().split(": ")).map(([k, v]) => [k, Number(v)]));
  assert.deepEqual(config, { thresholdRatio: 0.75, headroomTokens: 8192, retainRatio: 0.15, maxTokens: 16384, compactionRetries: 2, maxOverflowRetries: 2 });
  // rabi-compaction-basic's trigger: floor(min(W x ratio, W - reserved - headroom)).
  const trigger = (window) => Math.floor(Math.min(window * config.thresholdRatio, window - 0 - config.headroomTokens));
  assert.equal(trigger(131072), 98304);
  assert.equal(trigger(32768), 24576);
  assert.equal(trigger(1_048_576), 786432);
  assert.match(patch, / {4}- id: unieai-tool-search\n {6}name: "file:[^"]+unieai-tool-search\.mjs"\n/);
  assert.match(renderPatch({ defaultModel: "A", plugins: [], persona: false, toolSearch: { deferRatio: 0.05 } }), / {6}config:\n {8}deferRatio: 0\.05\n/);
  assert.doesNotMatch(renderPatch({ defaultModel: "A", plugins: [], persona: false, toolSearch: null }), /unieai-tool-search/);
});
