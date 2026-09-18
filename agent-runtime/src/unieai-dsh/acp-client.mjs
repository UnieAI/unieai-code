// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * acp-client.mjs — a minimal Agent Client Protocol client over a child's stdio.
 *
 * ACP is newline-delimited JSON-RPC 2.0. dsh (`--profile acp`) is the agent; we
 * are the client, so we send `initialize` / `session/*` requests and answer the
 * agent's `session/request_permission`. dsh does its own file and shell IO, so
 * no `fs/*` or `terminal/*` capability is advertised.
 *
 * Written against the wire rather than @agentclientprotocol/sdk so the runtime
 * does not need that package resolvable from here.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const ACP_PROTOCOL_VERSION = 1;

export class AcpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Speak ACP over an already-open pair of streams. Split from the spawning so
 * tests can drive it with an in-memory agent.
 */
export function createAcpConnection({ input, output, onError = () => {} }) {
  let nextId = 1;
  const pending = new Map();
  const requestHandlers = new Map();
  const notificationHandlers = new Map();
  let closed = false;

  const write = (message) => {
    if (closed) return;
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  const handleRequest = async (message) => {
    const handler = requestHandlers.get(message.method);
    if (!handler) {
      write({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
      return;
    }
    try {
      write({ id: message.id, result: (await handler(message.params ?? {})) ?? null });
    } catch (error) {
      write({ id: message.id, error: { code: -32603, message: String(error?.message || error) } });
    }
  };

  const lines = createInterface({ input });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onError(new Error(`acp: unparseable frame: ${line.slice(0, 200)}`));
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      void handleRequest(message);
    } else if (message.method !== undefined) {
      try {
        notificationHandlers.get(message.method)?.(message.params ?? {});
      } catch (error) {
        onError(error);
      }
    } else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        reject(new AcpError(message.error.message || "ACP request failed", message.error));
      } else {
        resolve(message.result);
      }
    }
  });
  lines.on("close", () => {
    closed = true;
    failAll(new AcpError("ACP agent closed the connection"));
  });

  return {
    request(method, params) {
      if (closed) return Promise.reject(new AcpError("ACP agent is not running"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      failAll(new AcpError("ACP connection closed"));
      lines.close();
    },
  };
}

/**
 * Spawn an ACP agent and complete the `initialize` handshake.
 *
 * `stderr` from the agent is passed to `onLog` line by line; stdout belongs to
 * the protocol.
 */
export async function spawnAcpAgent({ command, args = [], env, cwd, onLog = () => {}, onExit = () => {} }) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      onExit({ code, signal });
      resolve({ code, signal });
    });
  });
  const spawnError = new Promise((_, reject) => child.once("error", reject));
  createInterface({ input: child.stderr }).on("line", onLog);

  const connection = createAcpConnection({
    input: child.stdout,
    output: child.stdin,
    onError: (error) => onLog(`[acp] ${error.message}`),
  });
  const init = await Promise.race([
    connection.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "unieai-agent-core", version: "1" },
    }),
    spawnError,
    exited.then(({ code, signal }) => {
      throw new AcpError(`ACP agent exited during initialize (code ${code}, signal ${signal})`);
    }),
  ]);

  return {
    ...connection,
    agentInfo: init?.agentInfo ?? null,
    agentCapabilities: init?.agentCapabilities ?? {},
    exited,
    kill() {
      connection.close();
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/**
 * The line of an agent's stderr that says why it died: the first error line
 * (a stack's `SyntaxError: …`), else the last non-empty line.
 */
export function agentFailureReason(lines) {
  const meaningful = lines.map((line) => String(line).trim()).filter(Boolean);
  const error = meaningful.find((line) => /^(?:\w*Error\b|error:)/i.test(line) || /\b(?:SyntaxError|TypeError|ReferenceError|RangeError)\b/.test(line));
  return error ?? meaningful.at(-1) ?? null;
}
