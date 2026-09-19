// Copyright (c) 2026 UnieAI. All rights reserved.
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
  "thread/turns/list",
  "thread/resume",
  "thread/fork",
  "thread/revert",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
  "review/start",
];

const PROFILE_SANDBOX = { ":read-only": "read-only", ":workspace": "workspace-write", ":danger-full-access": "danger-full-access" };
const SANDBOX_NAMES = {
  "read-only": "read-only",
  readOnly: "read-only",
  "workspace-write": "workspace-write",
  workspaceWrite: "workspace-write",
  "danger-full-access": "danger-full-access",
  dangerFullAccess: "danger-full-access",
};

/**
 * The client's `-s` and `-a` from thread/start or thread/resume params, in
 * the engine's terms: `sandbox` is read-only | workspace-write |
 * danger-full-access, `approval` is "never" or "ask" (every codex policy
 * other than never still asks). Null where the client said nothing, so the
 * engine's default stands. A custom permission profile is not mapped.
 */
export function requestedPermissions(params) {
  const sandbox = PROFILE_SANDBOX[params?.permissions] ?? SANDBOX_NAMES[params?.sandbox] ?? null;
  const policy = params?.approvalPolicy;
  const approval = typeof policy !== "string" ? null : policy === "never" ? "never" : "ask";
  return { sandbox, approval };
}

const PROTOCOL_SANDBOX = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" };

/**
 * The user agent string. The daemon probe parses a version out of this
 * (`originator/version …`), and refuses the socket if it cannot — so the shape
 * matters more than the contents.
 */
export const userAgent = (version) => `unieai-agent-runtime/${version} (node ${process.versions.node})`;

/**
 * Build the protocol handlers over an engine factory.
 *
 * `createEngineFor({ cwd, model, resumeState, onState, ... })` returns
 * something with agent-runtime's engine shape; injected so the protocol can
 * be tested without a gateway. Beyond `send`, an engine may offer:
 *
 *   steer(text) -> bool | Promise<bool>     mid-turn input
 *   compact() -> Promise<bool>               manual compaction
 *   history() -> Promise<HistoryTurn[]>      completed + open user turns, in order
 *   fork({ keepTurns }) -> Promise<{ state, keptTurns }>   a new conversation
 *   revert({ keepTurns }) -> Promise<void>   drop later turns in place
 *   close() -> Promise<void>
 *
 * A HistoryTurn is `{ items: ThreadItem[], status, startedAt, completedAt }`;
 * item ids are assigned here. `onState(state)` reports what the engine needs
 * to reopen the conversation later (`resumeState`).
 *
 * With a `threadStore`, threads outlive the process: they are listed,
 * resumed, forked, reverted, renamed, archived and deleted here instead of
 * being forwarded to a Rust app-server that has never seen them.
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
  threadStore = null,
  // The engine variant a new thread runs in (uac: the dsh mode), read when
  // the thread starts; a forked thread keeps its source's.
  threadMode = () => null,
}) {
  // Thread state lives here, not in the Rust process: its ThreadStateManager
  // keeps threads in an in-process HashMap, so a thread created there is not
  // reachable from here. One owner is the only coherent choice.
  const threads = new Map();
  // Set by `initialize`; read where a decision depends on the client.
  let clientCapabilities = null;
  const epochNow = () => Math.floor(Date.now() / 1000);

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
  const turnShape = (turn, items = null) => ({
    id: turn.id,
    items: items ?? [],
    itemsView: items ? "full" : "notLoaded",
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
    t.activeTurn ? { type: "active", activeFlags: [] } : t.engine ? { type: "idle" } : { type: "notLoaded" };

  const threadShape = (t, turns = []) => ({
    id: t.id,
    extra: null,
    sessionId: t.id,
    forkedFromId: t.forkedFromId ?? null,
    parentThreadId: null,
    // Required since the upstream Thread gained project assignment.
    projectId: null,
    preview: t.preview ?? "",
    ephemeral: Boolean(t.ephemeral),
    // Legacy threads are hydrated with `thread/read(includeTurns)`, which is
    // exactly the history an engine can give; paging is not needed.
    historyMode: "legacy",
    modelProvider: t.modelProvider,
    createdAt: t.createdAtEpoch,
    updatedAt: t.updatedAtEpoch,
    recencyAt: t.updatedAtEpoch,
    status: threadStatus(t),
    path: null,
    cwd: t.cwd,
    cliVersion: version,
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: t.name ?? null,
    turns,
    // Not optional on the Rust side (no serde default), so a Thread without it
    // fails to deserialize and the client shows an empty pane.
    canAcceptDirectInput: true,
  });

  /** The session-settings half of thread/start, /resume and /fork responses. */
  const sessionResponse = (t, params, turns = []) => ({
    thread: threadShape(t, turns),
    // A string on the wire even when nobody chose a model.
    model: t.model || defaultModel || "",
    modelProvider: t.modelProvider,
    serviceTier: null,
    cwd: t.cwd,
    runtimeWorkspaceRoots: [t.cwd],
    instructionSources: [],
    approvalPolicy: params?.approvalPolicy || "on-request",
    approvalsReviewer: params?.approvalsReviewer || "user",
    // What the thread runs under: its own -s when it has one.
    sandbox: t.readOnly || (t.permissions?.sandbox ?? (sandboxMode === "readOnly" ? "read-only" : null)) === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : t.permissions?.sandbox === "danger-full-access" || sandboxMode === "dangerFullAccess"
        ? { type: PROTOCOL_SANDBOX["danger-full-access"] }
        : { type: "workspaceWrite", networkAccess: true },
    activePermissionProfile: {
      id: t.permissionProfile ?? (sandboxMode === "readOnly" || t.readOnly ? ":read-only" : ":workspace-write"),
      extends: null,
    },
    // dsh decides how much the model thinks; no effort is chosen here, and
    // "none" would read as thinking turned off.
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  });

  const newThread = ({ cwd, model, modelProvider, ephemeral = false, ...rest }) => {
    const epoch = epochNow();
    return {
      id: randomUUID(),
      cwd,
      model: model || defaultModel,
      modelProvider: modelProvider || defaultProvider,
      preview: "",
      name: null,
      archived: false,
      ephemeral,
      engine: null,
      engineState: null,
      activeTurn: null,
      turnIds: [],
      createdAtEpoch: epoch,
      updatedAtEpoch: epoch,
      ...rest,
    };
  };

  const persist = (t) => {
    if (threadStore && !t.ephemeral) threadStore.save(t);
  };

  /** A live thread, loading a stored one on first use. */
  const getThread = (threadId) => {
    const live = threads.get(threadId);
    if (live) return live;
    const stored = threadStore?.get(threadId);
    if (!stored) throw new RpcError(RPC.INVALID_PARAMS, `unknown thread: ${threadId}`);
    const thread = { ...newThread(stored), ...stored, engine: null, activeTurn: null };
    threads.set(thread.id, thread);
    return thread;
  };

  // The engine is built once per thread but items belong to a turn, so it
  // emits through a stable indirection that picks up the current turn.
  const ensureEngine = (thread, ctx) => {
    thread.connection = ctx ?? thread.connection;
    if (thread.engine) return thread.engine;
    thread.engine = createEngineFor({
      cwd: thread.cwd,
      model: thread.model,
      // What thread/start told the client is in force. Passing it on is what
      // makes that answer true rather than decorative.
      sandboxMode,
      resumeState: thread.engineState,
      onState: (state) => {
        thread.engineState = state;
        persist(thread);
      },
      // An approval request the client cannot place is one it drops. The
      // ids are read at ASK time, not captured, because the engine outlives
      // any one turn.
      ids: () => ({ threadId: thread.id, turnId: thread.activeTurn?.id ?? null }),
      newItemId,
      clientTools: () => thread.clientTools ?? null,
      oneShot: Boolean(thread.oneShot),
      mode: thread.mode ?? null,
      permissions: () => thread.permissions ?? null,
      request: (...args) => thread.connection.request(...args),
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
        return (pending?.emitItem ?? thread.connection?.emit)?.(method, params);
      },
    });
    return thread.engine;
  };

  const requireIdle = (thread, what) => {
    if (thread.activeTurn) {
      throw new RpcError(RPC.INVALID_REQUEST, `cannot ${what} while a turn is running`);
    }
  };

  /** The thread's turns with items, from the engine's history. */
  const historyTurns = async (thread, ctx) => {
    const engine = ensureEngine(thread, ctx);
    if (typeof engine.history !== "function") return legacyTurns(thread, engine);
    const history = await engine.history();
    return history.map((turn, index) => {
      // Ids given out live are kept; turns from before this index existed
      // (or an index that was lost) get stable synthetic ones.
      const id = thread.turnIds[index] ?? `${thread.id}:turn:${index}`;
      const live = thread.activeTurn?.id === id ? thread.activeTurn : null;
      const items = turn.items.map((item, k) => ({ ...item, id: `${id}:item:${k}` }));
      return turnShape(
        {
          id,
          status: live ? "inProgress" : turn.status ?? "completed",
          error: null,
          startedAt: turn.startedAt ?? null,
          completedAt: live ? null : turn.completedAt ?? null,
          durationMs: null,
        },
        items,
      );
    });
  };

  /**
   * agent-runtime's engine keeps plain messages; only what the protocol has a
   * shape for survives. A tool call has no honest reconstruction here.
   */
  const legacyTurns = (thread, engine) => {
    const items = [];
    for (const m of engine?.messages ?? []) {
      if (m.role === "user" && typeof m.content === "string" && !isSynthetic(m.content)) {
        items.push(userMessageItem(newItemId(), m.content));
      } else if (m.role === "assistant" && typeof m.content === "string" && m.content) {
        items.push(agentMessageItem(newItemId(), m.content));
      }
    }
    const id = thread.turnIds.at(-1) ?? `${thread.id}:turn:0`;
    return items.length ? [turnShape({ id, status: "completed" }, items)] : [];
  };

  const handlers = {
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
      const thread = newThread({
        cwd: params?.cwd || process.cwd(),
        model: params?.model,
        modelProvider: params?.modelProvider,
        ephemeral: params?.ephemeral ?? false,
        mode: threadMode(),
      });
      thread.connection = ctx;
      // A hidden, read-only ephemeral thread (the client's title generation
      // and other structured one-shots): answered by a single model call
      // with no tools, so "read-only" is true rather than a label.
      thread.readOnly = ["read-only", "readOnly"].includes(params?.sandbox);
      // No execution environment at all (`environments: []`) means the
      // client wants an answer, not an agent: the TUI starts its title
      // threads this way whether it asks for read-only or for a named
      // permission profile.
      const noEnvironment = Array.isArray(params?.environments) && params.environments.length === 0;
      thread.oneShot = Boolean(thread.ephemeral) && (thread.readOnly || noEnvironment);
      if (thread.oneShot) thread.readOnly = true;
      // A named profile the client asked for is the one in force: echo it.
      thread.permissionProfile = typeof params?.permissions === "string" ? params.permissions : null;
      // The client's -s / -a, applied to the engine session (see requestedPermissions).
      thread.permissions = thread.oneShot ? null : requestedPermissions(params);
      // Tools the client hosts (TUI task tools, cross-session messaging); the
      // engine offers them to the model and calls back with item/tool/call.
      thread.clientTools = Array.isArray(params?.dynamicTools) ? params.dynamicTools : null;
      threads.set(thread.id, thread);
      persist(thread);
      const response = sessionResponse(thread, params);
      // The TUI expects the notification as well as the response; without it the
      // session list and header stay empty.
      ctx?.emit?.("thread/started", { thread: response.thread });
      return response;
    },

    async "thread/read"(params, ctx) {
      const thread = getThread(params?.threadId);
      const turns = params?.includeTurns ? await historyTurns(thread, ctx) : [];
      return { thread: threadShape(thread, turns) };
    },

    async "turn/start"(params, ctx) {
      const thread = getThread(params?.threadId);
      requireIdle(thread, "start a turn");
      const text = textOf(params?.input);
      if (!thread.preview) thread.preview = text.slice(0, 120);
      ensureEngine(thread, ctx);
      const turnId = randomUUID();
      const startedAt = epochNow();
      thread.activeTurn = { id: turnId, abort: new AbortController(), status: "inProgress", error: null, startedAt, completedAt: null, durationMs: null };
      thread.turnIds.push(turnId);
      thread.updatedAtEpoch = startedAt;
      persist(thread);

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

      // The model's text comes in segments between tool calls. Each segment
      // is its own agentMessage (and reasoning) item, closed when a tool card
      // opens, so the transcript interleaves them as codex does; one item for
      // the whole turn put every remark after every command.
      // Streamed text has to name the item it belongs to; without `itemId` the
      // client cannot attach the delta to a card and drops it, which looks
      // exactly like the engine producing nothing at all.
      let answerSegment = null; // { id, text }
      let reasoningSegment = null; // { id, text }
      const emitAnswerDelta = (delta) => {
        if (!answerSegment) {
          answerSegment = { id: newItemId(), text: "" };
          emitItem("item/started", { item: agentMessageItem(answerSegment.id, ""), startedAtMs: Date.now() });
        }
        answerSegment.text += delta;
        emitItem("item/agentMessage/delta", { itemId: answerSegment.id, delta });
      };
      const emitReasoningDelta = (delta) => {
        if (!reasoningSegment) {
          reasoningSegment = { id: newItemId(), text: "" };
          emitItem("item/started", { item: reasoningItem(reasoningSegment.id), startedAtMs: Date.now() });
        }
        reasoningSegment.text += delta;
        emitItem("item/reasoning/textDelta", { itemId: reasoningSegment.id, delta, contentIndex: 0 });
      };
      const closeText = () => {
        if (reasoningSegment) {
          emitItem("item/completed", { item: reasoningItem(reasoningSegment.id, reasoningSegment.text), completedAtMs: Date.now() });
          reasoningSegment = null;
        }
        if (answerSegment) {
          if (answerSegment.text) emitItem("item/completed", { item: agentMessageItem(answerSegment.id, answerSegment.text), completedAtMs: Date.now() });
          answerSegment = null;
        }
      };
      // Any other card, including a steered user message, ends the segment.
      const TEXT_ITEMS = new Set(["agentMessage", "reasoning"]);
      thread.pendingAnswer = {
        emitItem: (method, itemParams) => {
          // A tool card opening ends the text segment before it.
          if (method === "item/started" && !TEXT_ITEMS.has(itemParams?.item?.type)) closeText();
          return emitItem(method, itemParams);
        },
        emitAnswerDelta,
        emitReasoningDelta,
      };

      // The turn runs past this response: the client learns what happened from
      // item/* notifications, exactly as it does with the Rust engine.
      thread.engine
        .send(text, { abortSignal: thread.activeTurn.abort.signal, outputSchema: params?.outputSchema ?? null, images: imagesOf(params?.input) })
        .then(() => closeText())
        .catch((error) => {
          // What was said before the failure stays on screen.
          closeText();
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
          thread.pendingAnswer = null;
          thread.updatedAtEpoch = epochNow();
          persist(thread);
          const completedAt = epochNow();
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
      const thread = getThread(params?.threadId);
      const text = textOf(params?.input);
      if (!text.trim()) throw new RpcError(RPC.INVALID_PARAMS, "steer needs some input");
      const turn = thread.activeTurn;
      if (!turn) throw new RpcError(RPC.INVALID_REQUEST, "no turn is running to steer");
      if (params?.expectedTurnId && params.expectedTurnId !== turn.id) {
        throw new RpcError(RPC.INVALID_REQUEST, `turn ${params.expectedTurnId} is no longer running`);
      }
      // The engine refuses when what is running cannot act on an interjection
      // (a compaction), and says so rather than dropping the text.
      const delivered = Boolean(await thread.engine?.steer?.(text));
      if (!delivered) throw new RpcError(RPC.INVALID_REQUEST, "the running turn did not accept the message");
      const itemId = newItemId();
      const emitItem = thread.pendingAnswer?.emitItem;
      emitItem?.("item/started", { item: userMessageItem(itemId, text), startedAtMs: Date.now() });
      emitItem?.("item/completed", { item: userMessageItem(itemId, text), completedAtMs: Date.now() });
      return { turnId: turn.id };
    },

    async "thread/compact/start"(params, ctx) {
      const thread = getThread(params?.threadId);
      requireIdle(thread, "compact");
      const engine = ensureEngine(thread, ctx);
      if (typeof engine.compact !== "function") {
        throw new RpcError(RPC.METHOD_NOT_FOUND, "compaction is not supported by this engine");
      }
      // Codex reports a manual compaction as a turn holding one
      // contextCompaction item, and answers the request before the work is
      // done: a failure is the turn's, not the request's (the TUI treats a
      // failed thread/compact/start as fatal).
      const turnId = randomUUID();
      const startedAt = epochNow();
      const itemId = newItemId();
      const stamp = { threadId: thread.id, turnId };
      thread.activeTurn = { id: turnId, abort: new AbortController(), status: "inProgress", error: null, startedAt, compaction: true };
      ctx?.emit?.("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
      ctx?.emit?.("turn/started", { ...stamp, turn: turnShape(thread.activeTurn) });
      ctx?.emit?.("item/started", { ...stamp, item: { type: "contextCompaction", id: itemId }, startedAtMs: Date.now() });
      Promise.resolve()
        .then(() => engine.compact())
        .then(
          () => ({ status: "completed", error: null }),
          (failure) => ({ status: "failed", error: { message: String(failure?.message || failure) } }),
        )
        .then(({ status, error }) => {
          thread.activeTurn = null;
          ctx?.emit?.("item/completed", { ...stamp, item: { type: "contextCompaction", id: itemId }, completedAtMs: Date.now() });
          if (error) ctx?.emit?.("error", { error, willRetry: false, ...stamp });
          const completedAt = epochNow();
          ctx?.emit?.("turn/completed", {
            threadId: thread.id,
            turn: turnShape({ id: turnId, status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 }),
          });
          ctx?.emit?.("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
        });
      return {};
    },

    async "thread/turns/list"(params, ctx) {
      const thread = getThread(params?.threadId);
      let turns = await historyTurns(thread, ctx);
      if (params?.itemsView === "notLoaded") turns = turns.map((turn) => ({ ...turn, items: [], itemsView: "notLoaded" }));
      if (params?.sortDirection !== "asc") turns.reverse();
      return { data: turns, nextCursor: null, backwardsCursor: null };
    },

    async "thread/items/list"(params, ctx) {
      const thread = getThread(params?.threadId);
      const turns = await historyTurns(thread, ctx);
      const data = turns
        .filter((turn) => !params?.turnId || turn.id === params.turnId)
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })));
      if (params?.sortDirection !== "asc") data.reverse();
      return { data, nextCursor: null, backwardsCursor: null };
    },

    async "turn/interrupt"(params) {
      const thread = threads.get(params?.threadId);
      thread?.activeTurn?.abort.abort();
      return {};
    },

    async "thread/resume"(params, ctx) {
      const thread = getThread(params?.threadId);
      // A resumed session takes the options of the launch resuming it.
      const wanted = requestedPermissions(params);
      if (wanted.sandbox || wanted.approval) thread.permissions = { ...thread.permissions, ...Object.fromEntries(Object.entries(wanted).filter(([, v]) => v)) };
      ensureEngine(thread, ctx);
      const turns = await historyTurns(thread, ctx);
      return sessionResponse(thread, params, turns);
    },

    async "thread/fork"(params, ctx) {
      const source = getThread(params?.threadId);
      requireIdle(source, "fork");
      const engine = ensureEngine(source, ctx);
      if (typeof engine.fork !== "function") {
        throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/fork is not supported by this engine");
      }
      let keepTurns = null;
      if (params?.lastTurnId) {
        const index = source.turnIds.indexOf(params.lastTurnId);
        if (index < 0) throw new RpcError(RPC.INVALID_PARAMS, `unknown turn: ${params.lastTurnId}`);
        keepTurns = index + 1;
      }
      const { state, keptTurns } = await engine.fork({ keepTurns });
      const thread = newThread({
        cwd: source.cwd,
        model: params?.model || source.model,
        modelProvider: source.modelProvider,
        ephemeral: params?.ephemeral ?? false,
        preview: source.preview,
        forkedFromId: source.id,
        mode: source.mode ?? null,
        engineState: state,
        turnIds: source.turnIds.slice(0, keptTurns),
      });
      thread.connection = ctx;
      threads.set(thread.id, thread);
      persist(thread);
      const turns = params?.excludeTurns ? [] : await historyTurns(thread, ctx);
      const response = sessionResponse(thread, params, turns);
      ctx?.emit?.("thread/started", { thread: { ...response.thread, turns: [] } });
      return response;
    },

    async "thread/revert"(params, ctx) {
      const thread = getThread(params?.threadId);
      requireIdle(thread, "revert");
      const engine = ensureEngine(thread, ctx);
      if (typeof engine.revert !== "function") {
        throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/revert is not supported by this engine");
      }
      const index = thread.turnIds.indexOf(params?.beforeTurnId);
      if (index < 0) throw new RpcError(RPC.INVALID_PARAMS, `unknown turn: ${params?.beforeTurnId}`);
      await engine.revert({ keepTurns: index });
      thread.turnIds = thread.turnIds.slice(0, index);
      thread.updatedAtEpoch = epochNow();
      persist(thread);
      // The client waits for this after the response before redrawing.
      setImmediate(() => ctx?.emit?.("thread/reverted", { threadId: thread.id }));
      return { thread: threadShape(thread), turnsBackwardsCursor: null, itemsBackwardsCursor: null };
    },

    // Goals are codex's long-running task loop; no engine here has one. Asking
    // for the goal is routine (the TUI does it on resume), so answer "none".
    async "thread/goal/get"(params) {
      getThread(params?.threadId);
      return { goal: null };
    },
    async "thread/goal/clear"(params) {
      getThread(params?.threadId);
      return { cleared: false };
    },
    async "thread/goal/set"() {
      throw new RpcError(RPC.METHOD_NOT_FOUND, "goals are not supported by this engine");
    },

    // Reviews run codex's review flow, which no engine here implements.
    async "review/start"() { throw new RpcError(RPC.METHOD_NOT_FOUND, "review/start is not supported by this engine"); },

    /** Exposed for tests and for the CLI's `/threads`-style introspection. */
    _threads: threads,
  };

  if (!threadStore) {
    // Without an index these threads are this process's alone: nothing to
    // list, and a resumed id could only be one we are still holding.
    handlers["thread/resume"] = async (params, ctx) => {
      const thread = threads.get(params?.threadId);
      if (!thread) throw new RpcError(RPC.METHOD_NOT_FOUND, "thread/resume is not supported by this engine");
      return sessionResponse(thread, params, await historyTurns(thread, ctx));
    };
    return handlers;
  }

  const listed = (t, params) => {
    // Like codex: a thread nobody has said anything in is not a session yet.
    if (t.ephemeral || !t.turnIds?.length) return false;
    if (Boolean(params?.archived) !== Boolean(t.archived)) return false;
    const cwds = params?.cwd == null ? null : [].concat(params.cwd);
    if (cwds && !cwds.includes(t.cwd)) return false;
    const term = String(params?.searchTerm ?? "").trim().toLowerCase();
    if (term && !`${t.name ?? ""} ${t.preview ?? ""}`.toLowerCase().includes(term)) return false;
    return true;
  };

  Object.assign(handlers, {
    async "thread/list"(params) {
      const key = params?.sortKey === "created_at" || params?.sortKey === "createdAt" ? "createdAtEpoch" : "updatedAtEpoch";
      const sorted = threadStore
        .list()
        .map((stored) => threads.get(stored.id) ?? { ...newThread(stored), ...stored, engine: null })
        .filter((t) => listed(t, params))
        .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
      if (params?.sortDirection === "asc") sorted.reverse();
      const offset = Number.parseInt(params?.cursor ?? "0", 10) || 0;
      const limit = Math.max(1, Math.min(Number(params?.limit) || 25, 200));
      const page = sorted.slice(offset, offset + limit);
      return {
        data: page.map((t) => threadShape(t)),
        nextCursor: offset + limit < sorted.length ? String(offset + limit) : null,
        backwardsCursor: null,
      };
    },

    async "thread/loaded/list"() {
      return { data: [...threads.values()].filter((t) => t.engine).map((t) => t.id), nextCursor: null };
    },

    async "thread/name/set"(params, ctx) {
      const thread = getThread(params?.threadId);
      thread.name = String(params?.name ?? "").trim() || null;
      persist(thread);
      ctx?.emit?.("thread/name/updated", { threadId: thread.id, threadName: thread.name });
      return {};
    },

    async "thread/archive"(params, ctx) {
      const thread = getThread(params?.threadId);
      thread.archived = true;
      persist(thread);
      ctx?.emit?.("thread/archived", { threadId: thread.id });
      return {};
    },

    async "thread/unarchive"(params, ctx) {
      const thread = getThread(params?.threadId);
      thread.archived = false;
      persist(thread);
      ctx?.emit?.("thread/unarchived", { threadId: thread.id });
      return { thread: threadShape(thread) };
    },

    async "thread/delete"(params, ctx) {
      const thread = getThread(params?.threadId);
      requireIdle(thread, "delete");
      await thread.engine?.close?.();
      threads.delete(thread.id);
      threadStore.delete(thread.id);
      ctx?.emit?.("thread/deleted", { threadId: thread.id });
      return {};
    },

    async "thread/unsubscribe"(params) {
      const thread = threads.get(params?.threadId);
      if (!thread?.engine) return { status: "notLoaded" };
      // A running turn keeps its engine; an idle one is reopened on demand.
      if (!thread.activeTurn) {
        await thread.engine.close?.();
        thread.engine = null;
      }
      return { status: "unsubscribed" };
    },
  });
  return handlers;
}

/**
 * Wrappers the engine injects into history that are not things the user said:
 * project instructions, context refreshes, and folded summaries.
 */
function isSynthetic(text) {
  return /^<(project_instructions|context_update|conversation_summary)>/.test(String(text ?? "").trimStart());
}

/** Pull the user's text out of the protocol's input shape. */
/**
 * The images in a turn's input (`-i`, pasted images): `{ path }` for a local
 * file, `{ url }` for an inline data URL. Other references are not carried.
 */
export function imagesOf(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((part) => {
    if (part?.type === "localImage" && typeof part.path === "string") return [{ path: part.path }];
    if (part?.type === "image" && typeof part.url === "string") return [{ url: part.url }];
    return [];
  });
}

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
export async function startAppServer({ socketPath, createEngineFor, codexHome, version, sandboxMode, threadStore = null, defaultModel = null, threadMode, forward = null, onError = () => {}, onTrace = null }) {
  const handlers = createHandlers({ createEngineFor, codexHome, version, sandboxMode, threadStore, defaultModel, threadMode });
  const dispatch = createDispatcher({ handlers, fallback: forward, onError });
  const trace = typeof onTrace === "function" ? onTrace : () => {};
  // Full payloads are large; opt in when a client renders something wrong.
  const tracePayloads = Boolean(process.env.UNIEAI_TRACE_PAYLOADS);
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
          // Which thread, always: the client runs hidden threads (titles)
          // alongside the visible one, and their traffic interleaves.
          const on = params?.threadId ? ` [${String(params.threadId).slice(0, 8)}]` : "";
          trace(`connection ${connId} ← ${method}${on}${tracePayloads ? ` ${JSON.stringify(params)}` : ""}`);
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
          const p = message.params ?? {};
          const detail = message.method === "turn/start"
            ? ` ${JSON.stringify(p).slice(0, 300)}`
            : message.method === "thread/start"
              ? ` ${JSON.stringify({ ephemeral: p.ephemeral, sandbox: p.sandbox, permissions: p.permissions, environments: p.environments })}`
              : "";
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
