// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-context-usage.mjs — what is using the context window, by kind.
 *
 * dsh's token meter knows the context's size (`measure().totalTokens`,
 * anchored on the last call's provider-reported usage) and prices every node
 * on the model-visible surface, but it only splits that into system / tools /
 * messages. This plugin folds the same priced nodes into the kinds a user can
 * act on: the system prompt, tool definitions (built-in, MCP, the client's
 * own), AGENTS.md instructions, skills, the conversation, tool results, a
 * compaction summary and runtime notices; plus the window and the token
 * count at which dsh compacts.
 *
 * The parts are the meter's fixed heuristic (four characters a token), so
 * they are estimates. When the last call reported usage, the parts are scaled
 * so they add up to the meter's measured total.
 *
 * Exposed as the `unieaiContextUsage` service (`measure(agent, options)`),
 * which the uac control channel answers the TUI's /context with, and as a
 * `/context` human command for hosts with dsh's command registry.
 *
 * No model-visible surface: nothing is added to a prompt or a tool list.
 */

export const name = "unieai-context-usage";

/** The kinds, in display order. */
export const CATEGORIES = Object.freeze([
  { id: "system", label: "System prompt" },
  { id: "toolsBuiltin", label: "Tools: built-in" },
  { id: "toolsMcp", label: "Tools: MCP" },
  { id: "toolsClient", label: "Tools: client" },
  { id: "instructions", label: "Instructions (AGENTS.md)" },
  { id: "skills", label: "Skills" },
  { id: "messages", label: "Messages" },
  { id: "toolResults", label: "Tool results" },
  { id: "summary", label: "Compaction summary" },
  { id: "notices", label: "Runtime context & notices" },
]);

// The meter's fixed heuristic, kept in step with dsh-token-meter's estimate.
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const schemaTokens = (tools) => (tools.length === 0 ? 0 : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN));

/** The kind of one surface event, from its type and source. */
export function categoryOf(event, toolNames) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case "system/message":
      return "system";
    case "assistant/message":
      return "messages";
    case "tool/result": {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId;
      return toolNames.get(callId) === "skill" ? "skills" : "toolResults";
    }
    case "user/message": {
      const source = data.source ?? {};
      if (source.kind === undefined || source.kind === "user") return "messages";
      if (source.kind === "agent-instructions") return "instructions";
      if (source.kind === "skill-catalog") return "skills";
      if (source.kind === "plugin" && source.plugin === "compact") return "summary";
      // A relayed agent message or a subagent's result is conversation, not
      // harness bookkeeping.
      if (source.kind === "agent-message" || source.kind === "subagent-settled") return "messages";
      return "notices";
    }
    default:
      return data.source?.plugin === "compact" ? "summary" : "messages";
  }
}

/**
 * The tool schemas of a request envelope by kind: `mcp__*` are MCP servers',
 * names in `clientToolNames` are the client's (the TUI's dynamic tools), the
 * rest are dsh's and its plugins'. Priced like the meter prices the envelope.
 */
export function toolBreakdown(tools = [], clientToolNames = new Set()) {
  const groups = { toolsBuiltin: [], toolsMcp: [], toolsClient: [] };
  for (const tool of tools) {
    const name = String(tool?.name ?? "");
    if (name.startsWith("mcp__")) groups.toolsMcp.push(tool);
    else if (clientToolNames.has(name)) groups.toolsClient.push(tool);
    else groups.toolsBuiltin.push(tool);
  }
  return {
    toolsBuiltin: schemaTokens(groups.toolsBuiltin) + (tools.length ? BLOCK_OVERHEAD : 0),
    toolsMcp: schemaTokens(groups.toolsMcp),
    toolsClient: schemaTokens(groups.toolsClient),
    counts: { toolsBuiltin: groups.toolsBuiltin.length, toolsMcp: groups.toolsMcp.length, toolsClient: groups.toolsClient.length },
  };
}

/**
 * Split integer `total` across `parts` in proportion to their weights, so the
 * rounded parts still add up to it (largest remainders take the leftovers).
 */
export function scaleTo(parts, total) {
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  if (sum === 0 || !Number.isFinite(total)) return { ...parts };
  const exact = Object.entries(parts).map(([key, value]) => [key, (value * total) / sum]);
  const out = Object.fromEntries(exact.map(([key, value]) => [key, Math.floor(value)]));
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  const order = exact.map(([key, value]) => [key, value - Math.floor(value)]).sort((a, b) => b[1] - a[1]);
  for (let i = 0; left > 0 && order.length > 0; i = (i + 1) % order.length, left -= 1) out[order[i][0]] += 1;
  return out;
}

/**
 * The context by kind, from a session's events and the meter's priced nodes.
 * Pure: everything it needs is passed in.
 *
 * @param {object} input
 * @param {Array} input.events - the session log (each `{seq, type, data}`).
 * @param {Array} input.nodes - `measure().nodes`: `{seq, tokens}` in surface order.
 * @param {Array} [input.tools] - the request envelope's tool schemas.
 * @param {Set<string>} [input.clientToolNames]
 * @param {object} [input.measured] - `{totalTokens, baseline}` from `measure()`.
 * @param {number|null} [input.contextWindow]
 * @param {number|null} [input.compactAt] - tokens at which dsh compacts.
 * @param {number|null} [input.compactRatio] - the configured ratio, for display.
 */
export function contextBreakdown({ events = [], nodes = [], tools = [], clientToolNames = new Set(), measured = null, contextWindow = null, compactAt = null, compactRatio = null }) {
  const bySeq = new Map();
  const toolNames = new Map();
  for (const event of events) {
    bySeq.set(Number(event.seq), event);
    if (event.type === "tool/call" && event.data?.callId) toolNames.set(event.data.callId, event.data.name);
  }
  const estimated = Object.fromEntries(CATEGORIES.map(({ id }) => [id, 0]));
  const items = Object.fromEntries(CATEGORIES.map(({ id }) => [id, 0]));
  for (const node of nodes) {
    const category = categoryOf(bySeq.get(Number(node.seq)), toolNames);
    estimated[category] += Number(node.tokens ?? node.heuristicTokens ?? 0) || 0;
    items[category] += 1;
  }
  const toolParts = toolBreakdown(tools, clientToolNames);
  for (const key of ["toolsBuiltin", "toolsMcp", "toolsClient"]) {
    estimated[key] = toolParts[key];
    items[key] = toolParts.counts[key];
  }
  const estimatedTotal = Object.values(estimated).reduce((a, b) => a + b, 0);
  // Provider-reported usage anchors the meter's total; only then is it more
  // than our own sum, and worth scaling the parts to.
  const calibrated = measured?.baseline?.kind === "usage" && Number.isFinite(measured.totalTokens);
  const total = calibrated ? measured.totalTokens : estimatedTotal;
  const parts = calibrated ? scaleTo(estimated, total) : estimated;
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  return {
    totalTokens: total,
    estimatedTokens: estimatedTotal,
    calibrated,
    contextWindow: window,
    freeTokens: window === null ? null : Math.max(0, window - total),
    compactAtTokens: Number.isFinite(compactAt) ? compactAt : null,
    compactRatio: Number.isFinite(compactRatio) ? compactRatio : null,
    categories: CATEGORIES.map(({ id, label }) => ({ id, label, tokens: parts[id], items: items[id] })),
  };
}

/**
 * Where dsh-compaction-basic compacts for this route: the configured share of
 * the window, capped by what is left after the output reservation and the
 * compaction headroom (its `resolveCompactSpec`). Null when compaction is
 * off, not dsh-compaction-basic, or the window is unknown.
 */
export function compactionThreshold(config, { provider, model, contextWindow, reservedTokens = 0 }) {
  if (!config || config.auto === false || !Number.isFinite(config.thresholdRatio) || !(contextWindow > 0)) return null;
  const override = (config.modelPolicies ?? []).find((policy) => policy.provider === provider && policy.model === model);
  const ratio = override?.thresholdRatio ?? config.thresholdRatio;
  const headroom = override?.headroomTokens ?? config.headroomTokens ?? 0;
  const budget = contextWindow - reservedTokens - headroom;
  return { ratio, tokens: Math.max(0, Math.floor(Math.min(contextWindow * ratio, budget))) };
}

/** Plain-text rendering, for the `/context` command and logs. */
export function renderText(usage) {
  const fmt = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const pct = (n) => (usage.contextWindow ? ` ${((100 * n) / usage.contextWindow).toFixed(1)}%` : "");
  const head = usage.contextWindow
    ? `Context: ${fmt(usage.totalTokens)} / ${fmt(usage.contextWindow)} tokens (${pct(usage.totalTokens).trim()})`
    : `Context: ${fmt(usage.totalTokens)} tokens`;
  const lines = [head];
  for (const row of usage.categories) {
    if (row.tokens === 0 && row.items === 0) continue;
    lines.push(`  ${row.label.padEnd(26)} ${fmt(row.tokens).padStart(7)}${pct(row.tokens)}`);
  }
  if (usage.freeTokens !== null) lines.push(`  ${"Free".padEnd(26)} ${fmt(usage.freeTokens).padStart(7)}${pct(usage.freeTokens)}`);
  if (usage.compactAtTokens !== null) lines.push(`Auto-compacts at ${fmt(usage.compactAtTokens)} tokens${pct(usage.compactAtTokens)}.`);
  lines.push(
    usage.calibrated
      ? "Parts are estimates (4 chars/token), scaled to the last request's reported prompt size."
      : "Estimates (4 chars/token); no request has reported usage yet.",
  );
  return lines.join("\n");
}

/** The latest `request/context` window in the log, if any. */
function loggedWindow(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "request/context" && Number.isFinite(events[i].data?.contextWindow)) return events[i].data.contextWindow;
  }
  return null;
}

/**
 * Before the first request there is no logged system prompt or tool list:
 * price what the next request would carry instead, from the system-prompt
 * assembly and the agent's visible tools. Best effort.
 */
async function unsentPreview(ctx, agent) {
  const preview = { system: 0, tools: [] };
  try {
    preview.tools = agent.ctx?.tools?.schemas?.(agent) ?? ctx.get?.("tools")?.schemas?.(agent) ?? [];
  } catch {
    // No tool view for this agent.
  }
  try {
    const assembly = await ctx.get?.("systemPrompt")?.assemble?.({ scope: agent });
    const text = (assembly?.sections ?? []).map((section) => section.text ?? "").join("\n\n");
    if (text) preview.system = Math.ceil(text.length / CHARS_PER_TOKEN) + 4;
  } catch {
    // The prompt assembles at the first step; nothing to show yet.
  }
  return preview;
}

/** Measure one live agent. */
export async function measureAgent(ctx, agent, { clientToolNames = [] } = {}) {
  const session = agent.session;
  const events = [...(session.snapshotEvents?.() ?? [])];
  const meter = agent.ctx?.get?.("tokenMeter") ?? ctx.get?.("tokenMeter");
  const measured = meter?.measure(session) ?? null;
  const header = session.requestHeader?.();
  let nodes = measured?.nodes ?? [];
  let tools = header?.tools ?? [];
  const sent = header !== undefined;
  if (!sent) {
    const preview = await unsentPreview(ctx, agent);
    tools = preview.tools;
    // A synthetic system node, so the preview prices like a logged prompt.
    if (preview.system) nodes = [...nodes, { seq: -1, tokens: preview.system }];
    events.push({ seq: -1, type: "system/message", data: {} });
  }
  const route = header?.config ?? { provider: agent.options?.provider, model: agent.options?.model };
  let contextWindow = loggedWindow(events) ?? session.requestContext?.()?.contextWindow ?? null;
  let defaultMaxTokens;
  try {
    const info = route.provider && route.model ? await ctx.get?.("llm")?.resolveModelInfo(route.provider, route.model) : undefined;
    contextWindow ??= info?.context?.contextWindow ?? null;
    defaultMaxTokens = info?.defaultMaxTokens;
  } catch {
    // An unknown route: no window to show.
  }
  const compaction = ctx.get?.("compaction");
  const threshold = compactionThreshold(compaction?.config, {
    provider: route.provider,
    model: route.model,
    contextWindow,
    reservedTokens: header?.config?.maxTokens ?? defaultMaxTokens ?? 0,
  });
  return {
    ...contextBreakdown({
      events,
      nodes,
      tools,
      clientToolNames: new Set(clientToolNames),
      measured,
      contextWindow,
      compactAt: threshold?.tokens ?? null,
      compactRatio: threshold?.ratio ?? null,
    }),
    sent,
    model: route.model ?? null,
  };
}

export function apply(ctx) {
  ctx.provide?.("unieaiContextUsage", {
    measure: (agent, options) => measureAgent(ctx, agent, options),
  });
  // dsh's own front ends (its TUI and web UI) run human commands; a host
  // without the registry simply never gets one.
  ctx.inject?.(["commands"], (scoped) => {
    scoped.effect?.(
      () =>
        scoped.commands.register({
          name: "context",
          description: "Show what is using the context window",
          handler: async (invocation) => ({ kind: "success", text: renderText(await measureAgent(ctx, invocation.agent)) }),
        }),
      "unieai-context-usage /context",
    );
  });
}
