// Copyright (c) 2026 UnieAI. All rights reserved.
// The `subagent` shadow and the delegation prompt line it has to replace.
// The plugin imports rabi's packages by their published names; in the source
// tree they are installed under their upstream dsh names.
import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@unieai\/rabi(-.*)?$/.exec(specifier);
    return nextResolve(match ? `@deepseek-ai/dsh${match[1] ?? ""}` : specifier, context);
  },
});

const plugin = await import("./uac-plugins/unieai-agents.mjs");
const { RABI_SPAWN_LEAD, SUBAGENT_LEAD, SUBAGENT_PROMPT_DESCRIPTION } = plugin;

const TAIL = "This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes.";

function rabiSubagentTool(calls) {
  return {
    name: "subagent",
    description: `${RABI_SPAWN_LEAD} ${TAIL}`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the delegated task, for display." },
        prompt: { type: "string", description: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs." },
      },
    },
    async execute(args) {
      calls.push(args);
      return { kind: "activation", subagentId: "child-1" };
    },
  };
}

/** A host with rabi's tools and one top-level agent; returns what the plugin registered. */
function boot({ fork = true, definitions = [] } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "unieai-agents-"));
  mkdirSync(join(repo, ".git"));
  if (definitions.length > 0) mkdirSync(join(repo, ".unieai", "agents"), { recursive: true });
  for (const [file, text] of definitions) writeFileSync(join(repo, ".unieai", "agents", file), text);
  const home = mkdtempSync(join(tmpdir(), "unieai-agents-home-"));

  const calls = [];
  const global = new Map([["subagent", rabiSubagentTool(calls)]]);
  if (fork) global.set("subagent_fork", { name: "subagent_fork", description: "fork", parameters: { properties: {} } });
  const listeners = new Map();
  const logger = { info() {}, warn() {} };
  const ctx = {
    logger,
    tools: { get: (toolName) => global.get(toolName), schemas: () => [...global.values()].map(({ name }) => ({ name })) },
    on: (event, fn) => listeners.set(event, fn),
  };
  plugin.apply(ctx, { home, claude: false });

  const scoped = new Map();
  const sections = new Map();
  const agent = {
    id: "main",
    session: { header: { cwd: repo } },
    ctx: {
      logger,
      tools: {
        register: (tool) => scoped.set(tool.name, tool),
        get: (toolName) => scoped.get(toolName) ?? global.get(toolName),
      },
      systemPrompt: {
        getSectionOrder: (slot) => (slot === "TOOL_SUBAGENT" ? 2800 : 0),
        section: (section) => {
          if (sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`);
          sections.set(section.name, section);
        },
      },
    },
  };
  listeners.get("agent/created")({ agent });
  const render = (sectionName) => {
    const section = sections.get(sectionName);
    return typeof section?.text === "function" ? section.text({ agent, scope: "main" }) : section?.text;
  };
  return { tool: scoped.get("subagent"), sections, render, calls };
}

test("subagent is reworded even when the project defines no agents", async () => {
  const { tool, calls } = boot();
  assert.ok(tool, "the shadow is installed with zero definitions");
  assert.ok(tool.description.startsWith(SUBAGENT_LEAD), "UnieAI's lead replaces rabi's");
  assert.ok(!tool.description.includes("so it does not consume this conversation's context"), "rabi's lead is gone");
  assert.ok(tool.description.endsWith(TAIL), "rabi's reporting details are kept");
  assert.match(tool.description, /in parallel/);
  assert.equal(tool.parameters.properties.prompt.description, SUBAGENT_PROMPT_DESCRIPTION);
  assert.equal(tool.parameters.properties.agent, undefined, "no agent parameter without definitions");

  // A call is rabi's call.
  assert.deepEqual(await tool.execute({ description: "d", prompt: "p" }, {}), { kind: "activation", subagentId: "child-1" });
  assert.deepEqual(calls, [{ description: "d", prompt: "p" }]);
});

test("with definitions the shadow also offers `agent`", () => {
  const { tool } = boot({
    definitions: [["reviewer.md", "---\nname: reviewer\ndescription: Reviews a diff.\n---\nYou review diffs.\n"]],
  });
  assert.ok(tool.description.startsWith(SUBAGENT_LEAD));
  assert.match(tool.description, /reviewer \(Reviews a diff\.\)/);
  assert.deepEqual(tool.parameters.properties.agent.enum, ["reviewer"]);
});

test("the lead being replaced is rabi's current wording", async () => {
  // If upstream rewords it, the shadow silently stops rewording; fail here instead.
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const lib = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-tool-subagent");
  assert.ok(readFileSync(lib, "utf8").includes(`description: ${JSON.stringify(RABI_SPAWN_LEAD)}`));
});

test("a base tool in other words is not misdescribed", () => {
  const base = { description: "Delegate a task to a subagent that inherits this conversation.", parameters: { properties: { prompt: { description: "keep" } } } };
  const wording = plugin.subagentWording(base);
  assert.equal(wording.description, base.description);
  assert.equal(wording.properties.prompt.description, "keep");
});

test("the parallel-delegation line names subagent once the tool is shadowed", () => {
  // rabi's TOOL_SUBAGENT line only names delegation tools it registered and
  // can still see; with `subagent` shadowed it named `subagent_fork` alone.
  const { render, sections } = boot();
  assert.equal(
    render("tool:subagent"),
    "Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.",
  );
  assert.equal(render("tool:subagent_fork"), "", "the fork-only line is emptied");
  assert.equal(sections.get("tool:subagent").order, 2800, "in rabi's slot");

  assert.equal(
    boot({ fork: false }).render("tool:subagent"),
    "Start independent delegations with `subagent` together in one assistant message and continue useful work while they run.",
  );
});

test("a delegated child gets neither the shadow nor the line", () => {
  const repo = mkdtempSync(join(tmpdir(), "unieai-agents-child-"));
  const listeners = new Map();
  const registered = [];
  plugin.apply(
    { logger: { info() {}, warn() {} }, tools: { get: () => rabiSubagentTool([]), schemas: () => [] }, on: (event, fn) => listeners.set(event, fn) },
    { home: repo, claude: false },
  );
  const child = {
    id: "child",
    session: { header: { cwd: repo, origin: "subagent" }, snapshotEvents: () => [] },
    ctx: { tools: { register: (tool) => registered.push(tool) }, systemPrompt: { section: (section) => registered.push(section) } },
  };
  listeners.get("agent/created")({ agent: child });
  assert.deepEqual(registered, []);
});
