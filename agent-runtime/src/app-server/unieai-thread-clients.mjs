// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-thread-clients.mjs — who a thread talks to: one driver, many
 * subscribers.
 *
 * One uac server serves every client on the machine: the TUI that started a
 * thread, another TUI that resumed it, a session whose model reads it, and
 * remote browsers (unieai-remote-bridge.mjs). A thread used to keep a single
 * `connection` that whichever client acted last took over, so a second client
 * touching a thread hijacked its approvals and the first TUI's client tools
 * (send_peer_message answered "the session mesh is not available" from the
 * wrong session). Here:
 *
 *  - Notifications go to every subscriber.
 *  - Approvals and questions go to every subscriber that can answer; the first
 *    answer wins, and every client that was asked is told
 *    `serverRequest/resolved` (with its own request id) so it can dismiss the
 *    prompt. A client that attaches while a request is open is asked too.
 *  - Client tools (`item/tool/call`) go to the driver only: the TUI that
 *    started the thread, which is the one hosting those tools. A client takes
 *    over as driver only when the driver is gone, and a remote never does.
 *
 * Everything fails closed: when nobody is left to answer a request, it is
 * rejected, which the approval bridge turns into a refusal.
 *
 * A client is the server's per-connection `ctx`: `{ emit, request, closed,
 * remote }`. `request(method, params, { timeoutMs, signal, onId })` must stop
 * waiting when `signal` aborts and report the request id it used via `onId`.
 */

/** Requests that only the driver can answer: they run in the client. */
const DRIVER_ONLY = new Set(["item/tool/call"]);

const live = (ctx) => Boolean(ctx) && !ctx.closed;

export function createThreadClients({ threadId }) {
  const subscribers = new Set();
  let driver = null;
  const open = new Set(); // fan-out requests nobody has answered yet

  const clients = {
    /** The live driver, or null. */
    get driver() {
      return live(driver) ? driver : null;
    },

    /** Live subscribers, the driver included. */
    subscribers() {
      return [...subscribers].filter(live);
    },

    /**
     * Subscribe `ctx`. With `drive`, it becomes the driver when there is no
     * live one (or always, with `drive: "claim"`: the client that starts a
     * thread owns it). A remote client never drives.
     */
    attach(ctx, { drive = false } = {}) {
      if (!ctx) return;
      subscribers.add(ctx);
      if (drive && !ctx.remote && (drive === "claim" || !live(driver))) driver = ctx;
      // An approval already waiting reaches a client that arrives late.
      for (const entry of open) entry.ask(ctx);
    },

    detach(ctx) {
      subscribers.delete(ctx);
      if (driver === ctx) driver = null;
      for (const entry of open) entry.forget(ctx);
    },

    /** Whether `ctx` is subscribed. */
    has(ctx) {
      return subscribers.has(ctx);
    },

    emit(method, params) {
      for (const ctx of clients.subscribers()) ctx.emit?.(method, params);
      return true;
    },

    request(method, params, options = {}) {
      if (DRIVER_ONLY.has(method)) {
        const owner = clients.driver;
        if (!owner?.request) {
          return Promise.reject(new Error("the session that hosts this thread's client tools is not connected"));
        }
        return owner.request(method, params, options);
      }
      return fanOut(method, params, options);
    },
  };

  const fanOut = (method, params, { timeoutMs = 0 } = {}) =>
    new Promise((resolve, reject) => {
      const asked = new Map(); // ctx -> { id, abort, failed }
      let done = false;
      let lastError = null;

      const finish = () => {
        done = true;
        open.delete(entry);
      };

      const settle = (winner, result) => {
        if (done) return;
        finish();
        for (const [ctx, slot] of asked) {
          if (ctx !== winner) slot.abort.abort();
          // Every client that was asked hears it is answered, the winner
          // too (as codex's server does): a prompt on another screen goes.
          if (slot.id !== null && live(ctx)) ctx.emit?.("serverRequest/resolved", { threadId, requestId: slot.id });
        }
        resolve(result);
      };

      // Nobody left who could still answer: fail closed.
      const checkExhausted = () => {
        if (done) return;
        const waiting = [...asked].some(([ctx, slot]) => !slot.failed && live(ctx));
        if (waiting) return;
        finish();
        reject(lastError ?? new Error("no client is connected to answer this request"));
      };

      const entry = {
        ask(ctx) {
          if (done || asked.has(ctx) || !live(ctx) || typeof ctx.request !== "function") return;
          const slot = { id: null, abort: new AbortController(), failed: false };
          asked.set(ctx, slot);
          let sent;
          try {
            sent = ctx.request(method, params, { timeoutMs, signal: slot.abort.signal, onId: (id) => (slot.id = id) });
          } catch (error) {
            sent = Promise.reject(error);
          }
          Promise.resolve(sent).then(
            (result) => settle(ctx, result),
            (error) => {
              if (done) return;
              slot.failed = true;
              lastError = error;
              checkExhausted();
            },
          );
        },
        forget(ctx) {
          const slot = asked.get(ctx);
          if (!slot || done) return;
          slot.abort.abort();
          slot.failed = true;
          checkExhausted();
        },
      };

      open.add(entry);
      for (const ctx of clients.subscribers()) entry.ask(ctx);
      if (asked.size === 0) {
        finish();
        reject(new Error("no client is connected to answer this request"));
      }
    });

  return clients;
}
