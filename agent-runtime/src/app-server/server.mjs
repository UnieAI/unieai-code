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
import { createItemBridge, userMessageItem, agentMessageItem, reasoningItem, newItemId } from "./items.mjs";

/** Methods this server answers itself. Everything else is forwarded. */
export const ENGINE_METHODS = [
  "initialize",
  "initialized",
  "thread/start",
  "thread/read",
  "turn/start",
  "turn/interrupt",
  // Thread-SCOPED, so they must be answered here even when unimplemented. The
  // Rust child keeps threads in its own in-process map; forwarding one of these
  // asks a different process about a thread it has never heard of, and the
  // answer is either an error or — worse — about some other thread entirely.
  "turn/steer",
  "thread/compact/start",
  "thread/items/list",
  "thread/resume",
  "thread/fork",
  "thread/rollback",
  "review/start",
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
export function createHandlers({
  createEngineFor,
  codexHome,
  version = "0.0.0",
  defaultModel = null,
  defaultProvider = "unieai",
  // What the engine's shell actually runs under. Reported to the client as-is:
  // the first cut hardcoded "readOnly" while the engine executed with
  // workspace-write, so the header promised a restriction nothing enforced.
  sandboxMode = "workspace-write",
  now = () => new Date().toISOString(),
}) {
  // Thread state lives here, not in the Rust process: its ThreadStateManager
  // keeps threads in an in-process HashMap, so a thread created there is not
  // reachable from here. One owner is the only coherent choice.
  const threads = new Map();
  // Set by `initialize`; read where a decision depends on the client.
  let clientCapabilities = null;

  // Mirrors what the Rust app-server actually returns (captured from a live
  // `thread/start`), not what the generated TypeScript suggests is optional —
  // the TUI reads more of this than the types imply, and a missing field shows
  // up as a blank pane rather than an error.
  // The protocol answers turn/start with a whole Turn, not just its id — a bare
  // id parses as a malformed response and the client drops the connection.
  // Captured from a live turn/start: `itemsView` and `status` are bare strings,
  // not the tagged unions the generated TypeScript reads like, and three timing
  // fields are always present. Getting this wrong makes the client reject the
  // response and drop the connection with no diagnosis on either side.
  const turnShape = (turn) => ({
    id: turn.id,
    items: [],
    itemsView: "notLoaded",
    status: turn.status,
    error: turn.error ?? null,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
  });

  /**
   * The protocol's ThreadStatus, which has no "running".
   *
   * The variants are `notLoaded` / `idle` / `systemError` / `active`, and
   * `active` carries `activeFlags`. We sent `{type:"running"}` — not a member of
   * the union, so the client dropped every status change we ever sent and the
   * header simply never updated.
   */
  const threadStatus = (t) =>
    t.activeTurn ? { type: "active", activeFlags: [] } : { type: "idle" };

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
    status: threadStatus(t),
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
    // Not optional on the Rust side (no serde default), so a Thread without it
    // fails to deserialize and the client shows an empty pane.
    canAcceptDirectInput: true,
  });

  return {
    // Part of the connection handshake, not a platform call: the stdio
    // app-server does not know this method, so forwarding it produces a loud and
    // meaningless "unknown variant" error. Absorb it here.
    async initialized() { return null; },

    async initialize(params) {
      // What the client says it supports shapes what we may send it. Ignoring it
      // meant answering every client identically, including ones that had opted
      // OUT of notifications we then sent anyway.
      clientCapabilities = params?.capabilities ?? null;
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
        sandbox: sandboxMode === "readOnly"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", networkAccess: true },
        activePermissionProfile: { id: sandboxMode === "readOnly" ? ":read-only" : ":workspace-write", extends: null },
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
        // The engine is built once per thread but items belong to a turn, so it
        // emits through a stable indirection that picks up the current turn.
        thread.engine = createEngineFor({
          cwd: thread.cwd,
          model: thread.model,
          // What thread/start told the client is in force. Passing it on is what
          // makes that answer true rather than decorative.
          sandboxMode,
          // An approval request the client cannot place is one it drops. The
          // ids are read at ASK time, not captured, because the engine outlives
          // any one turn.
          ids: () => ({ threadId: thread.id, turnId: thread.activeTurn?.id ?? null }),
          newItemId,
          request: ctx.request,
          emit: (method, params) => {
            const pending = thread.pendingAnswer;
            // Text deltas are routed through the turn's answer item so they carry
            // its id; everything else just gains the thread/turn stamps.
            if (method === "item/agentMessage/delta" && pending?.emitAnswerDelta) {
              return pending.emitAnswerDelta(params?.delta ?? "");
            }
            if (method === "item/reasoning/textDelta" && pending?.emitReasoningDelta) {
              return pending.emitReasoningDelta(params?.delta ?? "");
            }
            return (pending?.emitItem ?? ctx.emit)(method, params);
          },
        });
      }
      const turnId = randomUUID();
      const startedAt = Math.floor(Date.now() / 1000);
      thread.activeTurn = { id: turnId, abort: new AbortController(), status: "inProgress", error: null, startedAt, completedAt: null, durationMs: null };
      thread.updatedAtEpoch = Math.floor(Date.now() / 1000);

      // The lifecycle the client actually watches, in the order the Rust server
      // sends it: status, turn/started, the echoed user message, then items.
      ctx.emit("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
      ctx.emit("turn/started", { threadId: thread.id, turnId, turn: turnShape(thread.activeTurn) });

      // Every item notification carries the thread and turn it belongs to; the
      // client files them by those and ignores anything it cannot place.
      const emitItem = (method, params) =>
        ctx.emit(method, { threadId: thread.id, turnId, ...params });
      const userItemId = newItemId();
      emitItem("item/started", { item: userMessageItem(userItemId, text), startedAtMs: Date.now() });
      emitItem("item/completed", { item: userMessageItem(userItemId, text), completedAtMs: Date.now() });

      const answerId = newItemId();
      let answer = "";
      let answerOpened = false;
      // Streamed text has to name the item it belongs to; without `itemId` the
      // client cannot attach the delta to a card and drops it, which looks
      // exactly like the engine producing nothing at all.
      const emitAnswerDelta = (delta) => {
        if (!answerOpened) {
          answerOpened = true;
          emitItem("item/started", { item: agentMessageItem(answerId, ""), startedAtMs: Date.now() });
        }
        answer += delta;
        emitItem("item/agentMessage/delta", { itemId: answerId, delta });
      };
      // Reasoning gets its own item, opened on the first delta, for the same
      // reason as the answer: a delta that names no item is dropped.
      const reasoningId = newItemId();
      let reasoning = "";
      let reasoningOpened = false;
      const emitReasoningDelta = (delta) => {
        if (!reasoningOpened) {
          reasoningOpened = true;
          emitItem("item/started", { item: reasoningItem(reasoningId), startedAtMs: Date.now() });
        }
        reasoning += delta;
        emitItem("item/reasoning/textDelta", { itemId: reasoningId, delta, contentIndex: 0 });
      };
      thread.pendingAnswer = { id: answerId, emitItem, emitAnswerDelta, emitReasoningDelta };

      // The turn runs past this response: the client learns what happened from
      // item/* notifications, exactly as it does with the Rust engine.
      thread.engine
        .send(text, { abortSignal: thread.activeTurn.abort.signal })
        .then(() => {
          if (reasoningOpened) emitItem("item/completed", { item: reasoningItem(reasoningId, reasoning), completedAtMs: Date.now() });
          if (answer) emitItem("item/completed", { item: agentMessageItem(answerId, answer), completedAtMs: Date.now() });
        })
        .catch((error) => {
          if (thread.activeTurn) {
            thread.activeTurn.status = "failed";
            thread.activeTurn.error = { message: String(error?.message || error) };
          }
          // The client files an error by thread and turn and needs to know
          // whether to expect a retry; without those it cannot place the error
          // at all, so an engine failure was invisible.
          ctx.emit("error", {
            error: { message: String(error?.message || error) },
            willRetry: false,
            threadId: thread.id,
            turnId,
          });
        })
        .finally(() => {
          const finished = thread.activeTurn;
          thread.activeTurn = null;
          thread.updatedAtEpoch = Math.floor(Date.now() / 1000);
          const completedAt = Math.floor(Date.now() / 1000);
          ctx.emit("turn/completed", {
            threadId: thread.id,
            turn: turnShape({
              id: turnId,
              status: finished?.status === "failed" ? "failed" : "completed",
              error: finished?.error ?? null,
              startedAt: finished?.startedAt ?? null,
              completedAt,
              durationMs: finished?.startedAt ? (completedAt - finished.startedAt) * 1000 : null,
            }),
          });
          ctx.emit("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
        });
      return { turn: turnShape(thread.activeTurn) };
    },

    async "turn/steer"(params) {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${params?.threadId}`);
      const text = textOf(params?.input);
      if (!text.trim()) throw new RpcError(RPC.INVALID_PARAMS, "steer needs some input");
      // The engine refuses when nothing is running, or when what IS running is
      // not a regular turn — a compaction cannot act on an interjection.
      const delivered = Boolean(thread.engine?.steer(text));
      return { delivered };
    },

    async "thread/compact/start"(params, ctx) {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${params?.threadId}`);
      if (!thread.engine) return { compacted: false };
      const compacted = await thread.engine.compact();
      if (compacted) ctx?.emit?.("thread/compacted", { threadId: thread.id });
      return { compacted };
    },

    async "thread/items/list"(params) {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${params?.threadId}`);
      const messages = thread.engine?.messages ?? [];
      // Only what the protocol has a shape for. A tool call is reconstructed
      // from history as a command item; there is no honest way to recover the
      // ids the live notifications used, so these get fresh ones.
      const items = [];
      for (const m of messages) {
        if (m.role === "user" && typeof m.content === "string" && !isSynthetic(m.content)) {
          items.push(userMessageItem(newItemId(), m.content));
        } else if (m.role === "assistant" && typeof m.content === "string" && m.content) {
          items.push(agentMessageItem(newItemId(), m.content));
        }
      }
      return { items, nextCursor: null };
    },

    async "turn/interrupt"(params) {
      const thread = threads.get(params?.threadId);
      thread?.activeTurn?.abort.abort();
      return null;
    },

    // Thread-scoped and NOT implemented here. Answering METHOD_NOT_FOUND is the
    // honest reply; forwarding them would consult a thread map that does not
    // contain this thread.
    async "thread/resume"() { throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/resume is not supported by this engine"); },
    async "thread/fork"() { throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/fork is not supported by this engine"); },
    async "thread/rollback"() { throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/rollback is not supported by this engine"); },
    async "review/start"() { throw new RpcError(RPC.METHOD_NOT_FOUND, "review/start is not supported by this engine"); },

    /** Exposed for tests and for the CLI's `/threads`-style introspection. */
    _threads: threads,
  };
}

/**
 * Wrappers the engine injects into history that are not things the user said:
 * project instructions, context refreshes, and folded summaries.
 */
function isSynthetic(text) {
  return /^<(project_instructions|context_update|conversation_summary)>/.test(String(text ?? "").trimStart());
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
export async function startAppServer({ socketPath, createEngineFor, codexHome, version, sandboxMode, forward = null, onError = () => {}, onTrace = null }) {
  const handlers = createHandlers({ createEngineFor, codexHome, version, sandboxMode });
  const dispatch = createDispatcher({ handlers, fallback: forward, onError });
  const trace = typeof onTrace === "function" ? onTrace : () => {};
  let connections = 0;
  // Notifications that originate on the Rust side (fs/changed, account/updated,
  // mcpServer/startupStatus/updated…) belong to whoever is connected, not to a
  // request. Without somewhere to put them the forwarder simply dropped them.
  const live = new Set();

  const transport = serveJsonOverUnixSocket({
    socketPath,
    onError,
    onConnection: (conn) => {
      // Without this there is no way to tell a client that never connected from
      // one that connected and asked for something we mishandled.
      const connId = ++connections;
      trace(`connection ${connId} opened`);
      live.add(conn);
      // Approvals run the other way: the server asks, the client answers. Ids are
      // ours to allocate and ours to correlate, and they must not collide with
      // the client's — negative numbers keep the two namespaces apart.
      const pending = new Map();
      let nextRequestId = -1;
      const ctx = {
        // Engine progress reaches the client as notifications, which carry no id.
        emit: (method, params) => {
          trace(`connection ${connId} ← ${method}`);
          return conn.send({ method, params });
        },
        request: (method, params, { timeoutMs = 0 } = {}) =>
          new Promise((resolve, reject) => {
            const id = nextRequestId--;
            // v2 has no `timedOut` decision, and it does not need one: a user
            // who never answered has not approved anything.
            const timer = timeoutMs > 0
              ? setTimeout(() => { pending.delete(id); resolve({ decision: "decline" }); }, timeoutMs)
              : null;
            timer?.unref?.();
            pending.set(id, { resolve, reject, timer });
            if (!conn.send({ id, method, params })) {
              pending.delete(id);
              if (timer) clearTimeout(timer);
              // No client to ask: refuse rather than proceed unapproved.
              resolve({ decision: "decline" });
            }
          }),
      };
      conn.onMessage(async (message) => {
        if (message?.method) {
          // turn/start is where clients differ most (the `input` shape), so its
          // params are worth seeing when something silently does nothing.
          const detail = message.method === "turn/start" ? ` ${JSON.stringify(message.params ?? {}).slice(0, 300)}` : "";
          trace(`connection ${connId} → ${message.method}${detail}`);
        }
        // A response to something WE asked — route it to its waiter, not the
        // dispatcher, which only knows about client-initiated traffic.
        if (message?.id !== undefined && pending.has(message.id)) {
          const { resolve, reject, timer } = pending.get(message.id);
          pending.delete(message.id);
          if (timer) clearTimeout(timer);
          if (message.error) reject(new Error(message.error.message || "client refused the request"));
          else resolve(message.result ?? {});
          return;
        }
        const reply = await dispatch(message, ctx);
        if (reply?.error) trace(`connection ${connId} ✗ ${message.method}: ${reply.error.message}`);
        if (reply) conn.send(reply);
      });
      // A dropped connection must not leave a turn waiting on an answer forever.
      conn.onClose(() => {
        live.delete(conn);
        trace(`connection ${connId} closed`);
        for (const { resolve, timer } of pending.values()) {
          if (timer) clearTimeout(timer);
          resolve({ decision: "cancel" }); // the client is gone; cancel, not "maybe"
        }
        pending.clear();
      });
    },
  });

  await transport.listen();
  return {
    ...transport,
    handlers,
    socketPath,
    /** Push a server-originated notification to every connected client. */
    broadcast(method, params) {
      for (const conn of live) conn.send({ method, params });
    },
  };
}
