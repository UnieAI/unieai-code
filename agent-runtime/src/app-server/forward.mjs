// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * forward.mjs — hand the platform half of the protocol to the Rust app-server.
 *
 * We replace the ENGINE, not the platform. `fs/*`, `config/*`, `account/*`,
 * `plugin/*` and the rest are roughly eighty methods of workspace plumbing that
 * already exist, already track upstream, and have nothing to do with how a turn
 * is run. Reimplementing them would fork the platform and leave us chasing it
 * forever, so unknown methods are proxied to `unieai app-server` over stdio and
 * its answers returned verbatim.
 *
 * The child speaks the same JSON-RPC, one message per line.
 */
import { spawn } from "node:child_process";

/**
 * Start the Rust app-server as a child and return `forward(method, params)`.
 *
 * Ids are rewritten: our client's numbering and ours must not collide in the
 * child's namespace, so every forwarded call gets a fresh id and the answer is
 * matched back by it.
 */
export function createForwarder({ bin, args = ["app-server"], cwd, env = process.env, onError = () => {}, onNotification = null, clientInfo = { name: "unieai-agent-runtime", title: null, version: "0" }, spawnImpl = spawn, maxRestarts = 3, restartWindowMs = 60_000 }) {
  // The platform half is a child we can lose (it failed to open its state
  // database once while the TUI was creating it). Losing it must never take
  // the engine down with it: a failed child is logged, its pending calls get
  // errors, and the next forwarded call starts a new one — at most
  // `maxRestarts` times per `restartWindowMs`.
  let current = null;
  const restarts = [];

  const start = () => {
    const child = spawnImpl(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    const state = { child, alive: true, ready: null, call: null };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; } // the child also logs
        if (message.id !== undefined && pending.has(message.id)) {
          const { resolve, reject } = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) reject(Object.assign(new Error(message.error.message || "forwarded call failed"), { rpcCode: message.error.code }));
          else resolve(message.result);
        } else if (message.method && onNotification) {
          // The platform half emits notifications too (fs/changed, account/updated);
          // they belong to the client, not to us.
          onNotification(message.method, message.params);
        }
      }
    });
    child.stderr.on("data", (d) => onError(new Error(`app-server stderr: ${String(d).slice(0, 400)}`)));
    child.stdin.on("error", () => {}); // a dead child's pipe; the exit handler reports it
    const fail = (error) => {
      if (!state.alive) return;
      state.alive = false;
      for (const { reject } of pending.values()) reject(error);
      pending.clear();
      onError(error);
    };
    child.on("error", (error) => fail(error));
    child.on("exit", (code, signal) => fail(new Error(`app-server exited (${signal ?? code})`)));

    state.call = (method, params) =>
      new Promise((resolve, reject) => {
        if (!state.alive) {
          reject(new Error("app-server is not running"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });

    // The app-server refuses every other method until it has been initialized
    // ("Not initialized", -32600). Do the handshake once, up front, and make every
    // forwarded call wait for it — otherwise the first request through races it.
    // The TUI opts into the experimental API; without the same opt-in here,
    // forwarded methods such as collaborationMode/list are refused.
    state.ready = state
      .call("initialize", { clientInfo, capabilities: { experimentalApi: true } })
      .then((result) => {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        return result;
      });
    // Nobody may be waiting yet; a failed handshake is reported by `fail`.
    state.ready.catch(() => {});
    return state;
  };

  const live = () => {
    if (current?.alive) return current;
    const now = Date.now();
    while (restarts.length && now - restarts[0] > restartWindowMs) restarts.shift();
    if (current && restarts.length >= maxRestarts) {
      throw new Error(`the platform app-server keeps exiting (${restarts.length} restarts in ${Math.round(restartWindowMs / 1000)}s); see the uac server log`);
    }
    if (current) restarts.push(now);
    current = start();
    return current;
  };

  const first = live();
  return {
    get child() {
      return current?.child;
    },
    ready: first.ready,
    async forward(method, params) {
      const state = live();
      await state.ready;
      return state.call(method, params);
    },
    close() {
      const state = current;
      current = null;
      if (!state) return;
      try { state.child.stdin.end(); } catch { /* already gone */ }
      state.child.kill();
    },
  };
}
