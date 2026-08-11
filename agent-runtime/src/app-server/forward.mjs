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
export function createForwarder({ bin, args = ["app-server"], cwd, env = process.env, onError = () => {}, onNotification = null }) {
  const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";

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
  child.on("error", onError);
  child.on("exit", (code) => {
    const error = new Error(`app-server exited (${code})`);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });

  return {
    child,
    forward(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      try { child.stdin.end(); } catch { /* already gone */ }
      child.kill();
    },
  };
}
