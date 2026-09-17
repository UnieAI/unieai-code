// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-loop-testkit.mjs — a fake cordis context for the unieai-loop-* and
 * unieai-context-* plugin tests. Test-only; not a plugin.
 */

/** Listeners by event name, dispatched like cordis (registration order, `prepend` first). */
export function fakeContext(services = {}) {
  const hooks = new Map();
  const logs = [];
  const log = (level) => (...args) => logs.push([level, args.join(" ")]);
  const ctx = {
    logs,
    logger: { info: log("info"), warn: log("warn"), debug: log("debug") },
    on(name, callback, options) {
      const list = hooks.get(name) ?? [];
      if (options?.prepend) list.unshift(callback);
      else list.push(callback);
      hooks.set(name, list);
      return () => list.splice(list.indexOf(callback), 1);
    },
    listeners: (name) => hooks.get(name) ?? [],
    /** Cordis waterfall: outermost first, the last argument is the innermost `next`. */
    waterfall(name, ...args) {
      const callbacks = [...(hooks.get(name) ?? [])];
      const inner = args.pop();
      const next = () => (callbacks.shift() ?? inner)(...args, next);
      return next();
    },
    async serial(name, ...args) {
      for (const callback of hooks.get(name) ?? []) await callback(...args);
    },
    emit(name, ...args) {
      for (const callback of hooks.get(name) ?? []) callback(...args);
    },
    ...services,
  };
  return ctx;
}

export function fakeAgent({ id = "session-1", session = fakeSession() } = {}) {
  const steered = [];
  const agent = {
    id,
    session,
    status: "running",
    steered,
    cancelled: [],
    inbox: { nextStep: [] },
    steer(message) {
      steered.push(message);
      agent.inbox.nextStep.push(message);
    },
    cancel(cause) {
      agent.cancelled.push(cause);
    },
  };
  return agent;
}

/** A minimal append-only session with a positional surface. */
export function fakeSession(initial = []) {
  const events = [];
  const surface = { nodes: [] };
  const session = {
    events,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[Number(seq)],
    deriveEventMessage(event) {
      if (event.type === "user/message") return event.data;
      if (event.type === "assistant/message" || event.type === "tool/result" || event.type === "system/message") return event.data.message;
      return null;
    },
    append(type, data, intent) {
      const event = { seq: events.length, type, data };
      events.push(event);
      if (intent === undefined) return event;
      if (intent === "append" || intent?.surfaceOp === "append") surface.nodes.push(event.seq);
      else if (intent?.surfaceOp?.op === "replace") {
        const { startSeq, endSeq } = intent.surfaceOp;
        const start = surface.nodes.indexOf(startSeq);
        const end = surface.nodes.indexOf(endSeq);
        if (start < 0 || end < start) throw new Error(`bad replace ${startSeq}-${endSeq}`);
        surface.nodes.splice(start, end - start + 1, event.seq);
      }
      return event;
    },
  };
  for (const [type, data] of initial) {
    const surfaced = ["user/message", "assistant/message", "tool/result", "system/message"].includes(type);
    session.append(type, data, surfaced ? { surfaceOp: "append" } : undefined);
  }
  return session;
}

export async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export async function* fromArray(chunks) {
  for (const chunk of chunks) yield chunk;
}
