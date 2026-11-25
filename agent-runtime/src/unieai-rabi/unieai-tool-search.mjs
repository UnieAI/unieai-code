// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-tool-search.mjs — MCP tool schemas load on demand once they would
 * take a real share of the context window.
 *
 * Every MCP tool's description and input schema rides in every request. A
 * large server (UnieAI Space: 118 tools, ~85k characters of schema) would
 * hold a quarter of a 131k window's compaction budget before the first
 * message, and compaction cannot shrink the tool list. Claude Code defers MCP
 * tools behind its ToolSearch tool once their schemas pass 10% of the window;
 * this is the same for uac.
 *
 * How: rabi assembles each step's prompt (sections, contexts, tools) through
 * the `system-prompt/assemble` waterfall. When the `mcp__*` schemas there
 * exceed `deferRatio` of the route's context window, this plugin leaves them
 * out of the assembly (so the request, the logged request header and the
 * token meter all go without them) and offers `tool_search` instead, whose
 * description names every deferred tool. `tool_search` with
 * `select:<name>,...` or keywords marks the matching tools loaded for that
 * agent; from the next step on their full schemas are back in the tool list
 * and the model calls them natively.
 *
 * rabi's own `deferLoading` flag is not used: on an openai-completions route
 * (the UnieAI gateway) the adapter has no tool-update mode, strips the flag
 * and sends every tool anyway.
 *
 * Execution is untouched: a deferred tool is still registered, so a call to
 * one the model already knows (from history, or a resumed session) runs.
 * Loading a tool changes the tool list, which costs one uncached prompt on
 * providers that cache by prefix; the result asks for one batched call.
 *
 * Off with `UNIEAI_TOOL_SEARCH=off` (the plugin is then not loaded); `on`
 * defers MCP tools whatever their size; `auto:<percent>` sets the share.
 */

export const name = "unieai-tool-search";
export const inject = ["tools"];

export const TOOL_NAME = "tool_search";

export const DEFAULTS = Object.freeze({
  // Tools whose names start with this are deferrable (rabi's MCP naming).
  prefix: "mcp__",
  // Defer once the deferrable schemas pass this share of the context window
  // (Claude Code's auto threshold is 10%). 0 defers whenever there is one.
  deferRatio: 0.1,
  // When the route's window cannot be resolved.
  fallbackContextWindow: 131072,
  maxResults: 5,
  maxResultsLimit: 20,
});

// rabi-token-meter's heuristic for a tool schema.
const CHARS_PER_TOKEN = 4;

/** Estimated tokens of tool schemas, priced like rabi's meter prices the envelope. */
export function schemaTokens(tools) {
  return tools.length === 0 ? 0 : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

/** `UNIEAI_TOOL_SEARCH` -> null (off) or the plugin config it implies. */
export function toolSearchConfig(env = process.env) {
  const raw = String(env.UNIEAI_TOOL_SEARCH ?? "").trim().toLowerCase();
  if (["off", "0", "false", "no"].includes(raw)) return null;
  if (["on", "1", "true", "yes", "always"].includes(raw)) return { deferRatio: 0 };
  const auto = /^auto:(\d+(?:\.\d+)?)$/.exec(raw);
  if (auto && Number(auto[1]) <= 100) return { deferRatio: Number(auto[1]) / 100 };
  return {};
}

/**
 * Which tools of an assembly to defer: all `prefix` tools not yet loaded, once
 * the prefix tools together exceed `deferRatio × contextWindow` tokens.
 * Pure. `sticky` keeps deferring for an agent that already deferred, so the
 * tool list does not flip back when a server's list shrinks a little.
 * @returns {{ defer: boolean, deferred: object[], kept: object[], tokens: number }}
 */
export function planDeferral(tools, { prefix = DEFAULTS.prefix, deferRatio = DEFAULTS.deferRatio, contextWindow, loaded = new Set(), sticky = false }) {
  const deferrable = tools.filter((tool) => tool?.name?.startsWith(prefix) && tool.name !== TOOL_NAME);
  const tokens = schemaTokens(deferrable);
  const limit = Math.max(0, deferRatio) * (contextWindow > 0 ? contextWindow : DEFAULTS.fallbackContextWindow);
  const defer = deferrable.length > 0 && (sticky || tokens > limit);
  if (!defer) return { defer: false, deferred: [], kept: tools.filter((tool) => tool?.name !== TOOL_NAME), tokens };
  const deferred = deferrable.filter((tool) => !loaded.has(tool.name));
  const deferredNames = new Set(deferred.map((tool) => tool.name));
  return { defer: true, deferred, kept: tools.filter((tool) => !deferredNames.has(tool.name)), tokens };
}

/** `mcp__space__a, mcp__space__b` -> "mcp__space__: a, b" lines, by server. */
export function listDeferred(tools, prefix = DEFAULTS.prefix) {
  const groups = new Map();
  for (const tool of tools) {
    const rest = tool.name.slice(prefix.length);
    const cut = rest.indexOf("__");
    const server = cut > 0 ? `${prefix}${rest.slice(0, cut)}__` : prefix;
    const short = cut > 0 ? rest.slice(cut + 2) : rest;
    if (!groups.has(server)) groups.set(server, []);
    groups.get(server).push(short);
  }
  return [...groups].map(([server, names]) => `${server}: ${names.join(", ")}`).join("\n");
}

/** The tool_search description for this agent's deferred tools. */
export function describe(deferred, prefix = DEFAULTS.prefix) {
  return [
    `Load tools that are not in your tool list yet. ${deferred.length} MCP tools are deferred to save context: only their names are listed below.`,
    "Before calling one, load it: query `select:<full_name>[,<full_name>...]` loads those exact tools; any other query searches names and descriptions by keyword.",
    "Loaded tools join your tool list with their full schemas on your next step; call them directly then. Load every tool you expect to need in ONE call: each load changes the tool list.",
    "",
    "Deferred tools (prefix each name with its server prefix):",
    listDeferred(deferred, prefix),
  ].join("\n");
}

const words = (text) =>
  String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9À-￿]+/)
    .filter(Boolean);

/**
 * Tools matching a query: `select:a,b` (full names, or names without the
 * server prefix when that is unambiguous), else keyword search — a term in
 * the name scores higher than one in the description; `+term` is required.
 * @returns {{ matched: object[], missing: string[] }}
 */
export function searchTools(tools, query, { maxResults = DEFAULTS.maxResults } = {}) {
  const text = String(query ?? "").trim();
  const select = /^select:(.*)$/is.exec(text);
  if (select) {
    const matched = [];
    const missing = [];
    for (const wanted of select[1].split(",").map((part) => part.trim()).filter(Boolean)) {
      const exact = tools.find((tool) => tool.name === wanted);
      const suffixed = exact ? [exact] : tools.filter((tool) => tool.name.endsWith(`__${wanted}`) || tool.name.toLowerCase() === wanted.toLowerCase());
      if (suffixed.length === 1) {
        if (!matched.includes(suffixed[0])) matched.push(suffixed[0]);
      } else missing.push(wanted);
    }
    return { matched, missing };
  }
  const terms = text.split(/\s+/).filter(Boolean);
  const required = terms.filter((term) => term.startsWith("+") && term.length > 1).flatMap((term) => words(term.slice(1)));
  const optional = terms.filter((term) => !term.startsWith("+")).flatMap(words);
  const scored = [];
  for (const tool of tools) {
    const nameWords = words(tool.name);
    const nameText = tool.name.toLowerCase();
    const descText = String(tool.description ?? "").toLowerCase();
    const has = (term) => nameText.includes(term) || descText.includes(term);
    if (!required.every(has)) continue;
    let score = 0;
    for (const term of [...required, ...optional]) {
      if (nameWords.includes(term)) score += 10;
      else if (nameText.includes(term)) score += 5;
      else if (descText.includes(term)) score += 2;
    }
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return { matched: scored.slice(0, maxResults).map((entry) => entry.tool), missing: [] };
}

const firstLine = (text, max = 200) => {
  const line = String(text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The model-facing result text. */
export function renderResult({ query, matched, missing, alreadyLoaded = [] }) {
  const lines = [];
  if (matched.length > 0) {
    lines.push(`Loaded ${matched.length} tool${matched.length === 1 ? "" : "s"}: from your next step ${matched.length === 1 ? "it is" : "they are"} in your tool list with the full schema; call directly:`);
    for (const tool of matched) lines.push(`- ${tool.name}: ${firstLine(tool.description)}`);
  }
  if (alreadyLoaded.length > 0) lines.push(`Already in your tool list (call directly): ${alreadyLoaded.join(", ")}`);
  if (missing.length > 0) lines.push(`No deferred tool named: ${missing.join(", ")}`);
  if (lines.length === 0) lines.push(`No deferred tool matches "${query}". Try other keywords, or select:<name> with a name from the tool_search description.`);
  return lines.join("\n");
}

const PARAMETERS = {
  query: {
    type: "string",
    required: true,
    description: 'Either "select:<name>[,<name>...]" to load those tools, or keywords to search deferred tools (prefix a keyword with + to require it).',
  },
  max_results: { type: "number", description: `How many keyword matches to load (default ${DEFAULTS.maxResults}).` },
};

/** The route an assembly is for, then its context window. */
async function contextWindowOf(ctx, agent, assembly, fallback) {
  const logged = agent?.session?.requestContext?.()?.contextWindow;
  if (Number.isInteger(logged) && logged > 0) return logged;
  const provider = assembly?.variables?.provider ?? agent?.session?.requestHeader?.()?.config?.provider ?? agent?.options?.provider;
  const model = assembly?.variables?.model ?? agent?.session?.requestHeader?.()?.config?.model ?? agent?.options?.model;
  try {
    const info = provider && model ? await ctx.get?.("llm")?.resolveModelInfo?.(provider, model) : undefined;
    const window = info?.context?.contextWindow;
    if (Number.isInteger(window) && window > 0) return window;
  } catch {
    // An unknown route: the fallback window.
  }
  return fallback;
}

/**
 * @param ctx - the plugin context (rabi's cordis context).
 * @param rawConfig - DEFAULTS overrides.
 * @param deps - `defineTool` (rabi-tools'; injected by tests).
 */
export async function apply(ctx, rawConfig = {}, deps = {}) {
  const config = { ...DEFAULTS, ...rawConfig };
  const defineTool = deps.defineTool ?? (await import("@unieai/rabi-tools")).defineTool;
  // Per agent: tools it loaded, the deferred tools of its last assembly, and
  // whether it has deferred before.
  const states = new WeakMap();
  const stateOf = (agent) => {
    let state = states.get(agent);
    if (!state) {
      state = { loaded: new Set(), deferred: [], sticky: false };
      states.set(agent, state);
    }
    return state;
  };

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    const assembly = await next();
    const agent = context?.agent ?? context?.scope;
    const tools = assembly?.tools;
    if (!agent?.session || !Array.isArray(tools)) return assembly;
    const state = stateOf(agent);
    const hasDeferrable = tools.some((tool) => tool?.name?.startsWith(config.prefix) && tool.name !== TOOL_NAME);
    const contextWindow = hasDeferrable ? await contextWindowOf(ctx, agent, assembly, config.fallbackContextWindow) : 0;
    const plan = planDeferral(tools, { ...config, contextWindow, loaded: state.loaded, sticky: state.sticky });
    if (plan.defer && !state.sticky) {
      state.sticky = true;
      ctx.logger?.info?.(`${name}: deferring MCP tool schemas (~${plan.tokens} tokens, window ${contextWindow}) behind ${TOOL_NAME}`);
    }
    state.deferred = plan.deferred;
    // Not deferring: tool_search is left out. Deferring: it stays (also once
    // everything is loaded, so the list does not change again) and names
    // what is still deferred.
    if (plan.deferred.length === 0) return { ...assembly, tools: plan.kept };
    const description = describe(plan.deferred, config.prefix);
    return { ...assembly, tools: plan.kept.map((tool) => (tool.name === TOOL_NAME ? { ...tool, description } : tool)) };
  });

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: "Load deferred MCP tools by name (select:<name>,...) or keyword search, so they can be called.",
      parameters: PARAMETERS,
      output: {
        schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      presentCall: (args) => ({ card: "generic", title: `Tool search: ${String(args.query ?? "").slice(0, 80)}` }),
      async execute(args, exec) {
        const query = String(args.query ?? "").trim();
        if (!query) throw new Error("query must not be empty");
        const agent = exec?.agent;
        const state = agent ? stateOf(agent) : { loaded: new Set(), deferred: [] };
        const limit = Math.max(1, Math.min(config.maxResultsLimit, Number.isFinite(args.max_results) ? Math.floor(args.max_results) : config.maxResults));
        const { matched, missing: unmatched } = searchTools(state.deferred, query, { maxResults: limit });
        // A select naming a tool that is already loaded is not an error.
        const alreadyLoaded = unmatched.filter((wanted) => [...state.loaded].some((loadedName) => loadedName === wanted || loadedName.endsWith(`__${wanted}`)));
        const missing = unmatched.filter((wanted) => !alreadyLoaded.includes(wanted));
        for (const tool of matched) state.loaded.add(tool.name);
        if (matched.length > 0) ctx.logger?.info?.(`${name}: loaded ${matched.map((tool) => tool.name).join(", ")}`);
        return { text: renderResult({ query, matched, missing, alreadyLoaded }) };
      },
    }),
  );
}
