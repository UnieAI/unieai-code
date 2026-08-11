/**
 * server.mjs — the app-server protocol, served by our engine.
 *
 * The CLI's TUI is already a protocol client: on startup it probes
 * `$CODEX_HOME/app-server-control/app-server-control.sock` and, if something is
 * listening, talks JSON-RPC to it instead of using the embedded Rust engine
 * (see codex-rs/tui/src/lib.rs `maybe_probe_default_daemon_socket`). So putting
 * our engine behind that socket needs no change to the Rust side at all.
 *
 * Scope, deliberately: this owns the ENGINE methods — thread lifecycle and
 * turns — because those are what we are replacing. Everything else the TUI asks
 * for (fs/*, account/*, config/*, plugin/*, ~80 methods) is platform surface we
 * have no reason to reimplement; those go to `fallback`, which a caller wires to
 * the Rust app-server. Reimplementing them would fork the platform and leave us
 * chasing upstream forever.
 */
import { serveJsonOverUnixSocket } from "./ws.mjs";
import { createDispatcher, RpcError, RPC } from "./rpc.mjs";
import { randomUUID } from "node:crypto";

/** Methods this server answers itself. Everything else is forwarded. */
export const ENGINE_METHODS = [
  "initialize",
  "thread/start",
  "thread/read",
  "turn/start",
  "turn/interrupt",
];

/**
 * The user agent string. The daemon probe parses a version out of this
 * (`originator/version …`), and refuses the socket if it cannot — so the shape
 * matters more than the contents.
 */
export const userAgent = (version) => `unieai-agent-runtime/${version} (node ${process.versions.node})`;

/**
 * Build the protocol handlers over an engine factory.
 *
 * `createEngineFor({ cwd, model })` returns something with agent-runtime's
 * engine shape; injected so the protocol can be tested without a gateway.
 */
export function createHandlers({ createEngineFor, codexHome, version = "0.0.0", now = () => new Date().toISOString() }) {
  // Thread state lives here, not in the Rust process: its ThreadStateManager
  // keeps threads in an in-process HashMap, so a thread created there is not
  // reachable from here. One owner is the only coherent choice.
  const threads = new Map();

  const threadShape = (t) => ({
    id: t.id,
    sessionId: t.sessionId,
    forkedFromId: null,
    parentThreadId: null,
    preview: t.preview,
    ephemeral: Boolean(t.ephemeral),
    turns: [],
  });

  return {
    async initialize() {
      return {
        userAgent: userAgent(version),
        codexHome,
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
      };
    },

    async "thread/start"(params) {
      const id = randomUUID();
      const cwd = params?.cwd || process.cwd();
      const thread = {
        id,
        sessionId: randomUUID(),
        cwd,
        model: params?.model || null,
        preview: "",
        ephemeral: params?.ephemeral ?? false,
        engine: null,
        startedAt: now(),
      };
      threads.set(id, thread);
      return { thread: threadShape(thread), cwd };
    },

    async "thread/read"(params) {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${params?.threadId}`);
      return { thread: threadShape(thread) };
    },

    async "turn/start"(params, ctx) {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${params?.threadId}`);
      const text = textOf(params?.input);
      if (!thread.preview) thread.preview = text.slice(0, 120);
      if (!thread.engine) {
        thread.engine = createEngineFor({ cwd: thread.cwd, model: thread.model, emit: ctx.emit });
      }
      const turnId = randomUUID();
      thread.activeTurn = { id: turnId, abort: new AbortController() };
      // The turn runs past this response: the client learns what happened from
      // item/* notifications, exactly as it does with the Rust engine.
      thread.engine
        .send(text, { abortSignal: thread.activeTurn.abort.signal })
        .catch((error) => ctx.emit("error", { message: String(error?.message || error) }))
        .finally(() => { thread.activeTurn = null; });
      return { turnId };
    },

    async "turn/interrupt"(params) {
      const thread = threads.get(params?.threadId);
      thread?.activeTurn?.abort.abort();
      return null;
    },

    /** Exposed for tests and for the CLI's `/threads`-style introspection. */
    _threads: threads,
  };
}

/** Pull the user's text out of the protocol's input shape. */
export function textOf(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(input?.text || "");
}

/**
 * Listen on `socketPath` and serve the protocol.
 *
 * `forward` is optional: when absent, non-engine methods answer METHOD_NOT_FOUND
 * — useful in tests, wrong in production, where the platform surface has to
 * reach the Rust app-server.
 */
export async function startAppServer({ socketPath, createEngineFor, codexHome, version, forward = null, onError = () => {} }) {
  const handlers = createHandlers({ createEngineFor, codexHome, version });
  const dispatch = createDispatcher({ handlers, fallback: forward, onError });

  const transport = serveJsonOverUnixSocket({
    socketPath,
    onError,
    onConnection: (conn) => {
      const ctx = {
        // Engine progress reaches the client as notifications, which carry no id.
        emit: (method, params) => conn.send({ method, params }),
      };
      conn.onMessage(async (message) => {
        const reply = await dispatch(message, ctx);
        if (reply) conn.send(reply);
      });
    },
  });

  await transport.listen();
  return { ...transport, handlers, socketPath };
}
