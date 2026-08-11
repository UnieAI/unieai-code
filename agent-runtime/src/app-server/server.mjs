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
import { createItemBridge, userMessageItem, agentMessageItem, newItemId } from "./items.mjs";

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
export function createHandlers({ createEngineFor, codexHome, version = "0.0.0", defaultModel = null, defaultProvider = "unieai", now = () => new Date().toISOString() }) {
  // Thread state lives here, not in the Rust process: its ThreadStateManager
  // keeps threads in an in-process HashMap, so a thread created there is not
  // reachable from here. One owner is the only coherent choice.
  const threads = new Map();

  // Mirrors what the Rust app-server actually returns (captured from a live
  // `thread/start`), not what the generated TypeScript suggests is optional —
  // the TUI reads more of this than the types imply, and a missing field shows
  // up as a blank pane rather than an error.
  const threadShape = (t) => ({
    id: t.id,
    extra: null,
    sessionId: t.sessionId,
    forkedFromId: null,
    parentThreadId: null,
    preview: t.preview,
    ephemeral: Boolean(t.ephemeral),
    historyMode: "legacy",
    modelProvider: t.modelProvider,
    createdAt: t.createdAtEpoch,
    updatedAt: t.updatedAtEpoch,
    recencyAt: t.updatedAtEpoch,
    status: { type: t.activeTurn ? "running" : "idle" },
    path: t.path,
    cwd: t.cwd,
    cliVersion: version,
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
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

    async "thread/start"(params, ctx) {
      const id = randomUUID();
      const cwd = params?.cwd || process.cwd();
      const epoch = Math.floor(Date.now() / 1000);
      const thread = {
        id,
        sessionId: id, // the Rust server uses the same id for a fresh thread
        cwd,
        model: params?.model || defaultModel,
        modelProvider: params?.modelProvider || defaultProvider,
        preview: "",
        ephemeral: params?.ephemeral ?? false,
        engine: null,
        activeTurn: null,
        createdAtEpoch: epoch,
        updatedAtEpoch: epoch,
        path: null,
        startedAt: now(),
      };
      threads.set(id, thread);
      const shape = threadShape(thread);
      // The TUI expects the notification as well as the response; without it the
      // session list and header stay empty.
      ctx?.emit?.("thread/started", { thread: shape });
      return {
        thread: shape,
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: null,
        cwd,
        runtimeWorkspaceRoots: [cwd],
        instructionSources: [],
        approvalPolicy: params?.approvalPolicy || "on-request",
        approvalsReviewer: params?.approvalsReviewer || "user",
        sandbox: { type: "readOnly", networkAccess: false },
        activePermissionProfile: { id: ":read-only", extends: null },
        reasoningEffort: "none",
        multiAgentMode: "explicitRequestOnly",
      };
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
      thread.updatedAtEpoch = Math.floor(Date.now() / 1000);

      // The lifecycle the client actually watches, in the order the Rust server
      // sends it: status, turn/started, the echoed user message, then items.
      ctx.emit("thread/status/changed", { threadId: thread.id, status: { type: "running" } });
      ctx.emit("turn/started", { threadId: thread.id, turnId });
      const userItemId = newItemId();
      ctx.emit("item/started", { item: userMessageItem(userItemId, text) });
      ctx.emit("item/completed", { item: userMessageItem(userItemId, text) });

      const answerId = newItemId();
      let answer = "";
      thread.pendingAnswer = { id: answerId, onDelta: (d) => { answer += d; } };

      // The turn runs past this response: the client learns what happened from
      // item/* notifications, exactly as it does with the Rust engine.
      thread.engine
        .send(text, { abortSignal: thread.activeTurn.abort.signal })
        .then(() => {
          if (answer) ctx.emit("item/completed", { item: agentMessageItem(answerId, answer) });
        })
        .catch((error) => ctx.emit("error", { error: { message: String(error?.message || error) } }))
        .finally(() => {
          thread.activeTurn = null;
          thread.updatedAtEpoch = Math.floor(Date.now() / 1000);
          ctx.emit("turn/completed", { threadId: thread.id, turnId });
          ctx.emit("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
        });
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
