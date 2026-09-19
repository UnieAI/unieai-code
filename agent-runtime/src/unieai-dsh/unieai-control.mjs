// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-control.mjs — a dsh plugin that serves what ACP does not expose.
 *
 * dsh's ACP bridge offers prompt / cancel / new / resume / close. The
 * app-server protocol also needs steering a running turn, manual compaction,
 * the session's history (to rebuild a thread on resume), and forking at a turn
 * boundary (fork, and revert = fork minus the last turns). dsh has all of these
 * internally (`agent.steer`, `ctx.compaction`, `ctx.sessionQuery`,
 * seeded `ctx.agents.create`), so this plugin runs inside the dsh process and
 * answers newline-delimited JSON-RPC on a private unix socket.
 *
 * Session ids are shared with ACP: an ACP session id is the dsh session id.
 *
 * Client tools: the app-server client (the TUI) may offer its own tools at
 * thread start (`dynamicTools`: session list, cross-session messages, thread
 * delegation). `registerTools` registers them in that session's agent scope;
 * a call is sent back over the SAME connection as a `callTool` request, and
 * the bridge answers it by asking the client (`item/tool/call`).
 *
 * Loaded through the uac patch (see config.mjs `renderPatch`).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createMcpToolDefinition } from "@deepseek-ai/dsh-mcp-client";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { APPROVAL_POLICIES, setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";

export const name = "unieai-control";
export const inject = ["agents", "compaction", "sessionQuery", "sessions", "tools"];

/** Client tool specs (the app-server `DynamicToolSpec` shape) -> flat tool list. */
export function flattenClientTools(specs) {
  const out = [];
  for (const spec of Array.isArray(specs) ? specs : []) {
    if (spec?.type === "namespace") {
      for (const tool of spec.tools ?? []) {
        if (tool?.type === "function" || tool?.type === undefined) out.push({ ...tool, namespace: spec.name });
      }
    } else if (spec?.type === "function" || spec?.type === undefined) {
      out.push({ ...spec, namespace: null });
    }
  }
  return out
    .filter((tool) => typeof tool.name === "string" && tool.name && tool.inputSchema && typeof tool.inputSchema === "object")
    .map(({ name: toolName, description = "", inputSchema, namespace }) => ({ name: toolName, description, inputSchema, namespace }));
}

/** The client's `DynamicToolCallResponse` -> an MCP `CallToolResult`. */
export function mcpResultOf(response) {
  const items = Array.isArray(response?.contentItems) ? response.contentItems : [];
  const content = items.map((item) => {
    if (item?.type === "inputText") return { type: "text", text: String(item.text ?? "") };
    // Images and audio are URLs to the client; name them rather than drop them.
    if (item?.type === "inputImage") return { type: "text", text: `[image: ${item.imageUrl}]` };
    if (item?.type === "inputAudio") return { type: "text", text: `[audio: ${item.audioUrl}]` };
    return { type: "text", text: JSON.stringify(item) };
  });
  return { content: content.length ? content : [{ type: "text", text: "" }], isError: response?.success === false };
}

/** Plain text of a message's content blocks. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

const epochSeconds = (ms) => (Number.isFinite(ms) ? Math.floor(ms / 1000) : null);

/**
 * dsh events -> a flat, JSON-friendly history grouped by turn.
 *
 * Only turns opened for a user prompt count: they are the ones a client turn
 * id maps to, in order. Other turns (goal rounds, injected context) fold into
 * the preceding user turn so nothing the model did goes missing.
 */
export function historyFromEvents(events) {
  const turns = [];
  let pendingTurn = null; // a turn/start not yet known to be a user turn
  let current = null;
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case "turn/start":
        pendingTurn = { dshTurn: data.turn, startSeq: event.seq, startedAt: epochSeconds(event.time) };
        break;
      case "user/message": {
        const source = data.source?.kind;
        if (source === "user" && pendingTurn) {
          current = { ...pendingTurn, items: [], endSeq: null, reason: null };
          turns.push(current);
          pendingTurn = null;
        }
        if (source === "user" && current) {
          current.items.push({ type: "user", text: textOf(data.content) });
        }
        break;
      }
      case "assistant/message": {
        if (!current) break;
        const message = data.message ?? {};
        const reasoning = (message.content ?? [])
          .filter((block) => block?.type === "reasoning")
          .map((block) => block.text)
          .join("");
        const text = (message.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("");
        if (reasoning) current.items.push({ type: "reasoning", text: reasoning });
        if (text) current.items.push({ type: "assistant", text });
        break;
      }
      case "tool/call":
        if (!current) break;
        current.items.push({ type: "tool", callId: data.callId, name: data.name, arguments: data.arguments, status: "inProgress", output: "" });
        break;
      case "tool/result": {
        const result = data.message?.content?.[0];
        if (!result || !current) break;
        const call = current.items.find((item) => item.type === "tool" && item.callId === result.toolCallId);
        if (call) {
          call.status = result.isError ? "failed" : "completed";
          call.output = textOf(result.content);
        }
        break;
      }
      case "turn/end":
        if (current && current.dshTurn === data.turn) {
          current.endSeq = event.seq;
          current.reason = data.reason?.kind ?? null;
          current.completedAt = epochSeconds(event.time);
        }
        if (pendingTurn?.dshTurn === data.turn) pendingTurn = null;
        break;
      default:
        break;
    }
  }
  return turns;
}

/**
 * Where a fork keeping the first `keepTurns` user turns ends: just past the
 * last kept turn's `turn/end`, or before the first user turn when none are
 * kept. Returns null when a kept turn is still open.
 */
export function forkCut(events, keepTurns) {
  const turns = historyFromEvents(events);
  if (keepTurns > turns.length) return null;
  if (keepTurns === 0) {
    const first = turns[0];
    return first ? first.startSeq : events.length;
  }
  const last = turns[keepTurns - 1];
  if (last.endSeq === null) return null;
  // Keep everything through the end of the kept turn's non-user successors,
  // i.e. up to the start of the next user turn.
  const next = turns[keepTurns];
  return next ? next.startSeq : lastBalancedEnd(events) ?? last.endSeq + 1;
}

/** One past the last `turn/end`, the latest point with no open turn. */
function lastBalancedEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "turn/end") return events[index].seq + 1;
  }
  return null;
}

async function withObservation(ctx, sessionId, read) {
  const observed = await ctx.sessionQuery.observeSession(sessionId);
  try {
    return await read(observed);
  } finally {
    await observed[Symbol.asyncDispose]?.();
    observed[Symbol.dispose]?.();
  }
}

/** One dsh usage record as the app-server protocol's TokenUsageBreakdown. */
export function usageBreakdown(usage = {}) {
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  const cached = Number(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cachedTokens ?? 0) || 0;
  const cacheWrite = Number(usage.cacheWriteTokens ?? 0) || 0;
  const reasoning = Number(usage.reasoningTokens ?? usage.reasoningOutputTokens ?? 0) || 0;
  return {
    totalTokens: Number(usage.totalTokens ?? 0) || input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

/** Totals and the last model call, from a session's assistant messages. */
export function usageFromEvents(events) {
  const total = usageBreakdown({});
  let last = usageBreakdown({});
  for (const event of events ?? []) {
    if (event?.type !== "assistant/message" || !event.data?.usage) continue;
    last = usageBreakdown(event.data.usage);
    for (const key of Object.keys(total)) total[key] += last[key];
  }
  return { total, last };
}

export function apply(ctx, config = {}) {
  const socketPath = config.socket || process.env.UAC_CONTROL_SOCKET;
  if (!socketPath) {
    ctx.logger.warn("unieai-control: no socket configured; disabled");
    return;
  }
  const route = { provider: config.provider, model: config.model };
  /** sessionId -> disposers of the client tools registered for it. */
  const clientTools = new Map();
  const dropClientTools = (sessionId) => {
    for (const dispose of clientTools.get(sessionId) ?? []) {
      try {
        dispose();
      } catch {
        // The agent scope is already gone.
      }
    }
    clientTools.delete(sessionId);
  };
  ctx.on("agent/disposed", ({ agent }) => dropClientTools(agent.id));

  const methods = {
    /**
     * Register the client's tools for one session (replacing earlier ones).
     * Calls go back to the client over the connection that registered them.
     */
    async registerTools({ sessionId, tools }, peer) {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error(`session is not open: ${sessionId}`);
      dropClientTools(sessionId);
      const disposers = [];
      for (const tool of flattenClientTools(tools)) {
        const definition = createMcpToolDefinition(ctx, {
          name: tool.name,
          rawName: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          call: async (args, exec) =>
            mcpResultOf(
              await peer.request("callTool", {
                sessionId,
                callId: exec.callId,
                namespace: tool.namespace,
                tool: tool.name,
                arguments: args,
              }),
            ),
        });
        try {
          disposers.push(agent.ctx.tools.register(definition));
        } catch (error) {
          ctx.logger.warn(`unieai-control: client tool ${tool.name} not registered: ${error?.message ?? error}`);
        }
      }
      clientTools.set(sessionId, disposers);
      return { registered: disposers.length };
    },

    /**
     * The client's `-s` / `-a` for one session, as dsh's own per-session
     * `sandbox/mode` and `approval/policy` events (what its permission
     * picker writes). Only a change is appended, so resuming a session does
     * not grow its log.
     */
    async setPermissions({ sessionId, sandbox = null, approval = null }) {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error(`session is not open: ${sessionId}`);
      const events = agent.session.snapshotEvents?.() ?? [];
      const last = (type, key) => events.findLast?.((event) => event?.type === type)?.data?.[key] ?? null;
      const applied = {};
      if (sandbox && SANDBOX_MODES.includes(sandbox) && last("sandbox/mode", "mode") !== sandbox) {
        setSandboxMode(agent.session, sandbox);
        applied.sandbox = sandbox;
      }
      if (approval && APPROVAL_POLICIES.includes(approval) && last("approval/policy", "policy") !== approval) {
        setApprovalPolicy(agent.session, approval);
        applied.approval = approval;
      }
      return { applied };
    },

    /** Token usage so far in the session (the TUI's /status and header). */
    async usage({ sessionId }) {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error(`session is not open: ${sessionId}`);
      const { total, last } = usageFromEvents(agent.session.snapshotEvents?.() ?? []);
      const window = agent.session.requestContext?.()?.contextWindow ?? null;
      return { total, last, modelContextWindow: Number.isFinite(window) ? window : null };
    },

    async steer({ sessionId, text }) {
      const agent = ctx.agents.get(sessionId);
      if (!agent || !String(text ?? "").trim()) return { delivered: false };
      agent.steer(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
      return { delivered: true };
    },

    async compact({ sessionId }) {
      const agent = ctx.agents.get(sessionId);
      if (!agent) throw new Error(`session is not open: ${sessionId}`);
      const result = await ctx.compaction.compactNow(agent, AbortSignal.timeout(10 * 60_000));
      return { compacted: result !== null };
    },

    async history({ sessionId }) {
      return withObservation(ctx, sessionId, (observed) => ({ turns: historyFromEvents(observed.events) }));
    },

    /**
     * A new session holding the first `keepTurns` user turns of `sessionId`
     * (all completed turns when omitted). The child is persisted and left
     * closed so the client opens it with ACP `session/resume`.
     */
    async fork({ sessionId, keepTurns = null, provider, model }) {
      return withObservation(ctx, sessionId, async (observed) => {
        const events = observed.events;
        const total = historyFromEvents(events).filter((turn) => turn.endSeq !== null).length;
        const keep = keepTurns === null ? total : Math.max(0, Math.min(keepTurns, total));
        const cut = forkCut(events, keep);
        if (cut === null) throw new Error("the turn to fork through has not completed");
        const childId = randomUUID();
        const cwd = observed.header?.cwd;
        const handle = await ctx.agents.create({
          sessionId: childId,
          seed: events.slice(0, cut),
          inheritedEventCount: cut,
          // No parentSession: ACP refuses to resume a session that has one.
          meta: { ...(cwd === undefined ? {} : { cwd }), isSeeded: true },
          agentOptions: { provider: provider ?? route.provider, model: model ?? route.model },
        });
        try {
          // Flushing is what materializes the new session's log on disk.
          await ctx.sessions.flush(handle.agent.session);
        } finally {
          await handle.dispose();
        }
        return { sessionId: childId, keptTurns: keep };
      });
    },
  };

  rmSync(socketPath, { force: true });
  const server = createServer((socket) => {
    const write = (message) => socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    // The connection is two-way: the bridge calls methods here, and client
    // tools call back to the bridge (`callTool`) on the same socket.
    let nextId = 0;
    const pending = new Map();
    const peer = {
      request(method, params) {
        const id = `unieai-control:${(nextId += 1)}`;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          write({ id, method, params });
        });
      },
    };
    createInterface({ input: socket }).on("line", async (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (request.method === undefined) {
        const waiter = pending.get(request.id);
        if (!waiter) return;
        pending.delete(request.id);
        if (request.error) waiter.reject(new Error(request.error.message ?? "client tool failed"));
        else waiter.resolve(request.result);
        return;
      }
      const handler = methods[request.method];
      if (!handler) {
        write({ id: request.id, error: { code: -32601, message: `unknown method: ${request.method}` } });
        return;
      }
      try {
        write({ id: request.id, result: await handler(request.params ?? {}, peer) });
      } catch (error) {
        write({ id: request.id, error: { code: -32603, message: String(error?.message || error) } });
      }
    });
    const failPending = () => {
      for (const waiter of pending.values()) waiter.reject(new Error("the bridge disconnected"));
      pending.clear();
    };
    socket.on("close", failPending);
    socket.on("error", () => {});
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    ctx.logger.info(`unieai-control: listening on ${socketPath}`);
  });
  ctx.on("dispose", () => {
    server.close();
    rmSync(socketPath, { force: true });
  });
}
