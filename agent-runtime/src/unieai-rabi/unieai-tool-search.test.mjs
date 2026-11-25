// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import test from "node:test";
// rabi's packages under their upstream names (the ones installed here).
import { Context } from "@unieai/cordis";
import { SystemPrompt } from "@unieai/rabi-system-prompt";
import { ToolRuntime, defineTool } from "@unieai/rabi-tools";
import * as NativeExecutor from "@unieai/rabi-tool-executor-native";
import { renderPatch } from "./config.mjs";
import { TOOL_NAME, apply, describe as describeTool, installDefinitionFilter, listDeferred, planDeferral, schemaTokens, searchTools, toolSearchConfig } from "./unieai-tool-search.mjs";

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

const agentWith = (contextWindow) => ({ session: { requestContext: () => ({ provider: "unieai", model: "m", contextWindow }) } });

/** rabi's own prompt and tool services, `tools` registered globally, and this plugin. */
async function host(tools) {
  const root = new Context();
  root.plugin(SystemPrompt, {});
  root.plugin(ToolRuntime, {});
  root.plugin(NativeExecutor, {});
  root.inject(["tools"], (ctx) => {
    for (const tool of tools) {
      ctx.tools.register(
        defineTool({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters.properties,
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
          execute: async () => `ran ${tool.name}`,
        }),
      );
    }
  });
  root.plugin({ name: "unieai-tool-search", inject: ["tools"], apply: (ctx) => apply(ctx, {}, { defineTool }) });
  for (let i = 0; i < 50 && !root.tools?.get?.(TOOL_NAME); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(root.tools.get(TOOL_NAME), "tool_search registered");
  /** One step as rabi's agent loop prepares it: admission, then assembly. */
  const step = async (agent) => {
    const toolSet = await root.tools.resolve({ agent, modelSelection: { provider: "unieai", model: "m" }, signal: new AbortController().signal });
    const assembly = await root.systemPrompt.assemble({ scope: agent, toolSet });
    return { toolSet, tools: assembly.tools, names: assembly.tools.map((tool) => tool.name) };
  };
  return { root, step };
}

// Built-ins without tool_search (this plugin registers its own).
const exec = builtin.filter((tool) => tool.name !== TOOL_NAME);

test("deferred schemas leave the step's tool list; tool_search loads them for the next step", async () => {
  const { root, step } = await host([...exec, ...smallServer, ...bigServer]);
  const agent = agentWith(131072);

  let current = await step(agent);
  assert.deepEqual(current.names, ["exec_command", TOOL_NAME]);
  const search = current.tools.find((tool) => tool.name === TOOL_NAME);
  assert.match(search.description, /120 MCP tools are deferred/);
  assert.ok(schemaTokens(current.tools) < 1500, `${schemaTokens(current.tools)}`);

  const tool = root.tools.executable(TOOL_NAME, agent, current.toolSet);
  const result = await tool.execute({ query: "select:kb_search,tool_042" }, { agent });
  assert.match(result.text, /Loaded 2 tools/);
  assert.match(result.text, /mcp__space__tool_042/);
  assert.deepEqual(tool.output.render({}, result), [{ type: "text", text: result.text }]);

  current = await step(agent);
  assert.deepEqual(new Set(current.names), new Set(["exec_command", TOOL_NAME, "mcp__unieai_studio__kb_search", "mcp__space__tool_042"]));
  const loaded = current.tools.find((t) => t.name === "mcp__unieai_studio__kb_search");
  assert.equal(loaded.parameters.properties.q.type, "string");
  assert.match(current.tools.find((t) => t.name === TOOL_NAME).description, /118 MCP tools are deferred/);

  const again = await tool.execute({ query: "select:tool_042" }, { agent });
  assert.match(again.text, /Already in your tool list/);
  // Bad arguments are refused by rabi's own validation.
  await assert.rejects(tool.execute({}, { agent }));

  // Execution is untouched: a deferred tool stays callable in the step.
  const direct = root.tools.executable("mcp__space__tool_009", agent, current.toolSet);
  assert.ok(direct, "a deferred tool is still admitted for dispatch");
  assert.equal(await direct.execute({ id: "a" }, { agent }), "ran mcp__space__tool_009");
  // Inspection without a step tool set sees every registration.
  assert.equal(root.tools.schemas(agent).length, 1 + 2 + 118 + 1);
});

test("a small MCP server, or a big window, keeps every schema and leaves tool_search out", async () => {
  const small = await host([...exec, ...smallServer]);
  const agent = agentWith(131072);
  const narrow = await small.step(agent);
  assert.deepEqual(narrow.names, ["exec_command", ...smallServer.map((t) => t.name)]);
  // Left out of the step entirely: not declared and not dispatchable.
  assert.equal(small.root.tools.executable(TOOL_NAME, agent, narrow.toolSet), undefined);
  assert.ok(small.root.tools.executable("exec_command", agent, narrow.toolSet));

  const big = await host([...exec, ...bigServer]);
  const wide = await big.step(agentWith(1_048_576));
  assert.equal(wide.names.length, 1 + bigServer.length);
  assert.ok(!wide.names.includes(TOOL_NAME));
});

test("each agent defers on its own window and keeps its own loaded tools", async () => {
  const { root, step } = await host([...exec, ...bigServer]);
  const narrow = agentWith(131072);
  const wide = agentWith(1_048_576);
  const first = await step(narrow);
  assert.deepEqual(first.names, ["exec_command", TOOL_NAME]);
  assert.equal((await step(wide)).names.length, 1 + bigServer.length);
  await root.tools.executable(TOOL_NAME, narrow, first.toolSet).execute({ query: "select:tool_001" }, { agent: narrow });
  assert.deepEqual((await step(narrow)).names, ["exec_command", "mcp__space__tool_001", TOOL_NAME]);
});

test("installDefinitionFilter: one wrapper per class, inspection untouched, removable", () => {
  class Registry {
    definitions(scope, toolSet) {
      return [{ name: "a" }, { name: "b" }];
    }
  }
  const registry = new Registry();
  const drop = installDefinitionFilter(registry, (_scope, list) => list.filter((t) => t.name !== "a"));
  const rename = installDefinitionFilter(new Registry(), (_scope, list) => list.map((t) => ({ ...t, seen: true })));
  assert.deepEqual(registry.definitions({}, {}), [{ name: "b", seen: true }]);
  assert.deepEqual(registry.definitions({}), [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(registry.definitions(undefined, {}), [{ name: "a" }, { name: "b" }]);
  drop();
  rename();
  assert.deepEqual(registry.definitions({}, {}), [{ name: "a" }, { name: "b" }]);
  assert.equal(installDefinitionFilter({}, () => []), null);
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
