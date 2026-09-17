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
 * Loaded through the uac patch (see config.mjs `renderPatch`).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "unieai-control";
export const inject = ["agents", "compaction", "sessionQuery", "sessions"];

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

export function apply(ctx, config = {}) {
  const socketPath = config.socket || process.env.UAC_CONTROL_SOCKET;
  if (!socketPath) {
    ctx.logger.warn("unieai-control: no socket configured; disabled");
    return;
  }
  const route = { provider: config.provider, model: config.model };

  const methods = {
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
    createInterface({ input: socket }).on("line", async (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      const handler = methods[request.method];
      if (!handler) {
        write({ id: request.id, error: { code: -32601, message: `unknown method: ${request.method}` } });
        return;
      }
      try {
        write({ id: request.id, result: await handler(request.params ?? {}) });
      } catch (error) {
        write({ id: request.id, error: { code: -32603, message: String(error?.message || error) } });
      }
    });
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
