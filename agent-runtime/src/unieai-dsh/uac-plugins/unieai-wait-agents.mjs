// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-wait-agents.mjs — wait for background subagents instead of polling.
 *
 * dsh's `subagent` tool can run children in the background, but the parent
 * has no way to block until they finish: it calls `list_agents` over and over
 * (16 polls in one FrontierHarness task), each call a full model step. codex
 * has a blocking `wait`. This plugin adds `wait_agents`:
 *
 *   wait_agents { agent_ids?, all?, timeout_ms? }
 *
 * It returns when one (or, with `all`, every) awaited child settles, or at
 * the timeout, and reports each settled child's stop reason and final
 * answer, so the parent usually needs no further call to read results.
 * Without `agent_ids` it waits on the caller's own running children.
 *
 * Children are tracked from dsh's `subagent/start` / `subagent/end` events
 * and filed under the parent their session names (`header.parentSession`,
 * the same link dsh checks before letting a parent message a child), so a
 * parent only ever sees and waits on its own children.
 *
 * `subagent/end` is not enough on its own. A continuable child (the default
 * for spawned subagents) stays resident after its turn, and dsh ends that
 * residency only once the child's result has been delivered to the parent's
 * inbox — which the parent reads at its next step, and the parent is inside
 * this tool. Waiting for `subagent/end` therefore always ran to the timeout.
 * A child is also taken as finished when its own session log shows its
 * latest turn ended and the agent is idle, the same log dsh reads to report
 * the child's result.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "unieai-wait-agents";
export const inject = ["tools", "agents"];

export const DEFAULTS = Object.freeze({ defaultTimeoutMs: 300_000, maxTimeoutMs: 1_800_000, maxOutputChars: 4_000 });

/**
 * The state of a resident child from its own session log, after `boundary`:
 * null while it is working (or has not started), else how its latest turn
 * ended and what it last said.
 */
export function childTurnState(agent, boundary = 0) {
  if (!agent || agent.status !== "idle" || typeof agent.session?.snapshotEvents !== "function") return null;
  const events = agent.session.snapshotEvents().filter((event) => (event?.seq ?? 0) >= boundary);
  let lastStart = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "turn/start") {
      lastStart = i;
      break;
    }
  }
  if (lastStart < 0) return null;
  const tail = events.slice(lastStart);
  const end = tail.find((event) => event?.type === "turn/end");
  if (!end) return null;
  const said = tail.filter((event) => event?.type === "assistant/message").at(-1)?.data?.message?.content;
  return { stopReason: STOP_REASONS[end.data?.reason?.kind] ?? end.data?.reason?.kind ?? "completed", lastAssistantMessage: said };
}

const STOP_REASONS = { completed: "completed", "max-tokens": "max-tokens", aborted: "aborted", interrupted: "aborted", error: "error", blocked: "refusal" };

const textOf = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");

/**
 * Per-parent registry of children: id -> { running, stopReason, output, endedAt }.
 * Parents are keyed by session id; a parent's entry is dropped with it.
 */
export function createChildRegistry() {
  const parents = new Map();
  const waiters = new Map(); // parent -> Set<() => void>
  const childrenOf = (parent) => {
    let map = parents.get(parent);
    if (!map) {
      map = new Map();
      parents.set(parent, map);
    }
    return map;
  };
  const wake = (parent) => {
    for (const notify of waiters.get(parent) ?? []) notify();
  };
  return {
    started(parent, info) {
      childrenOf(parent).set(String(info.id), { id: String(info.id), running: true, stopReason: null, output: "", endedAt: null, boundary: info.boundary ?? 0 });
      wake(parent);
    },
    ended(parent, info) {
      const map = childrenOf(parent);
      const entry = map.get(String(info.id)) ?? { id: String(info.id) };
      map.set(entry.id, { ...entry, running: false, stopReason: info.stopReason ?? null, output: textOf(info.lastAssistantMessage), endedAt: Date.now() });
      wake(parent);
    },
    children: (parent) => [...childrenOf(parent).values()],
    forget(parent) {
      parents.delete(parent);
      wake(parent);
      waiters.delete(parent);
    },
    /** Resolves on the next change for `parent`, or when `signal` aborts. */
    nextChange(parent, signal) {
      return new Promise((resolve) => {
        let set = waiters.get(parent);
        if (!set) {
          set = new Set();
          waiters.set(parent, set);
        }
        const done = () => {
          set.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        set.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    },
  };
}

/**
 * Wait on `parent`'s children per the tool arguments; resolves the tool value.
 * `refresh(parent)` brings the registry up to date from the children
 * themselves; it runs before each check and every `pollMs`.
 */
export async function waitForChildren(registry, parent, args, { cfg = DEFAULTS, signal, refresh = () => {}, pollMs = 500 } = {}) {
  refresh(parent);
  const startedAt = Date.now();
  const timeoutMs = Math.min(
    Number.isFinite(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : cfg.defaultTimeoutMs,
    cfg.maxTimeoutMs,
  );
  const known = () => registry.children(parent);
  const wanted = Array.isArray(args.agent_ids) && args.agent_ids.length > 0 ? new Set(args.agent_ids.map(String)) : null;
  const unknown = wanted ? [...wanted].filter((id) => !known().some((child) => child.id === id)) : [];
  if (unknown.length > 0) {
    throw new Error(`not your subagent(s): ${unknown.join(", ")}. Use the ids returned by the subagent tool or list_agents.`);
  }
  // Without ids: the children running now, plus any that finished since a
  // wait last reported them — a fast child can finish before the parent
  // gets here, and its answer must not fall between two calls.
  const targets = wanted ?? new Set(known().filter((child) => child.running || !child.reported).map((child) => child.id));
  const snapshot = () => known().filter((child) => targets.has(child.id));
  const settled = () => snapshot().filter((child) => !child.running);
  const satisfied = () => {
    const done = settled().length;
    return targets.size === 0 || (args.all === true ? done === targets.size : done > 0);
  };

  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  const stop = AbortSignal.any([timer.signal, ...(signal ? [signal] : [])]);
  try {
    while (!satisfied() && !stop.aborted) {
      const tick = new AbortController();
      const poll = setTimeout(() => tick.abort(), pollMs);
      await registry.nextChange(parent, AbortSignal.any([stop, tick.signal]));
      clearTimeout(poll);
      refresh(parent);
    }
  } finally {
    clearTimeout(timeout);
  }
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");

  for (const child of snapshot()) if (!child.running) child.reported = true;
  const clip = (text) => (text.length > cfg.maxOutputChars ? `${text.slice(0, cfg.maxOutputChars)}… [truncated]` : text);
  const children = snapshot().map((child) => ({
    agent_id: child.id,
    status: child.running ? "running" : "finished",
    ...(child.running ? {} : { stop_reason: child.stopReason ?? "unknown", output: clip(child.output) }),
  }));
  return {
    timed_out: !satisfied(),
    waited_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    children,
    // Children that finished earlier are listed so nothing is lost between calls.
    ...(wanted || targets.size > 0 ? {} : { note: "No subagents were running; nothing to wait for." }),
  };
}

function render(value) {
  const lines = [];
  if (value.note) lines.push(value.note);
  if (value.timed_out) lines.push(`Timed out after ${value.waited_seconds}s.`);
  for (const child of value.children) {
    if (child.status === "running") lines.push(`${child.agent_id}: still running`);
    else lines.push(`${child.agent_id}: finished (${child.stop_reason})${child.output ? `\n${child.output}` : ""}`);
  }
  return lines.join("\n\n") || "No subagents to wait for.";
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const registry = createChildRegistry();

  const parentOf = (info) => ctx.agents?.get(info.id)?.session?.header?.parentSession;
  const known = new Map(); // child id -> parent id (the child may be gone at subagent/end)
  ctx.on("subagent/start", (info) => {
    const parent = parentOf(info);
    if (parent === undefined) return; // not an in-process child; nothing to wait on here
    known.set(String(info.id), parent);
    // Only this epoch's turns count: a resumed child's old turns are done.
    const boundary = ctx.agents?.get(info.id)?.session?.seq ?? 0;
    registry.started(parent, { ...info, boundary });
  });
  const refresh = (parent) => {
    for (const child of registry.children(parent)) {
      if (!child.running) continue;
      const state = childTurnState(ctx.agents?.get(child.id), child.boundary);
      if (state) registry.ended(parent, { id: child.id, ...state });
    }
  };
  ctx.on("subagent/end", (info) => {
    const parent = known.get(String(info.id)) ?? parentOf(info);
    known.delete(String(info.id));
    if (parent !== undefined) registry.ended(parent, info);
  });
  ctx.on("agent/disposed", ({ agent }) => {
    registry.forget(agent.id);
    // A child's own disposal comes BEFORE its subagent/end (seen under the
    // ACP profile), so its link to the parent must outlive it; the end edge
    // drops it. A parent's disposal drops its children's links.
    for (const [child, parent] of known) if (parent === agent.id) known.delete(child);
  });

  ctx.tools.register(
    defineTool({
      name: "wait_agents",
      description:
        "Wait for background subagents you started to finish, instead of polling list_agents. " +
        "Returns when one of them finishes (or all of them with `all: true`), or at the timeout, " +
        "with each finished subagent's stop reason and final answer. Omit agent_ids to wait on all your running subagents.",
      parameters: {
        agent_ids: { type: "array", items: { type: "string" }, description: "Subagent ids to wait on (from the subagent tool). Defaults to all your running subagents." },
        all: { type: "boolean", description: "Wait until every awaited subagent has finished. Defaults to false (return on the first)." },
        timeout_ms: { type: "number", description: `Maximum wait. Defaults to ${cfg.defaultTimeoutMs} ms; at most ${cfg.maxTimeoutMs} ms.` },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            timed_out: { type: "boolean", required: true },
            waited_seconds: { type: "number", required: true },
            children: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  agent_id: { type: "string", required: true },
                  status: { type: "string", required: true },
                  stop_reason: { type: "string" },
                  output: { type: "string" },
                },
              },
            },
            note: { type: "string" },
          },
        },
        render: (_args, value) => [{ type: "text", text: render(value) }],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error("wait_agents needs a calling agent");
        return waitForChildren(registry, exec.agent.id, args, { cfg, signal: exec.signal, refresh });
      },
    }),
  );
}
