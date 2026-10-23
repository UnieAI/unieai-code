// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-launch.mjs — serve the app-server protocol on a unix socket from an engine.
 *
 * Shared by the entry points in bin/: each supplies how a thread's engine is
 * built; the socket, the forwarder to the Rust app-server, and shutdown are the
 * same for all of them.
 */
import { chmodSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { startAppServer } from "./server.mjs";
import { createForwarder } from "./forward.mjs";
import { createItemBridge } from "./items.mjs";
import { createApprovalBridge } from "./approval.mjs";
import { loadCredentials, sandboxBin } from "../config.mjs";

export const log = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);

/**
 * `buildEngine({ cwd, model, threadId, sandboxMode, resumeState, onState, onText,
 * onReasoning, onToolEvent, requestApproval })` returns an engine for one
 * thread. `threadStore` (see unieai-thread-store.mjs) makes threads persistent.
 * `onShutdown` runs before the process exits. `onHandOver` runs when a
 * SIGTERM hands the socket to another server while clients remain (see
 * createStopControls).
 */
/** How long the server waits for another client before stopping. */
const IDLE_EXIT_MS = Number(process.env.UNIEAI_UAC_IDLE_EXIT_MS) || 15_000;

export async function launchAppServer({ name, version, buildEngine, sandboxMode, threadStore = null, defaultModel = null, threadMode, resolveModel, onShutdown = async () => {}, onHandOver = () => {} }) {
  let idleTimer = null;
  const codexHome = process.env.CODEX_HOME || process.env.UNIEAI_HOME || join(homedir(), ".unieai");
  const socketPath =
    process.env.UNIEAI_APP_SERVER_SOCKET || join(codexHome, "app-server-control", "app-server-control.sock");

  mkdirSync(dirname(socketPath), { recursive: true });
  // A socket file left by a crashed process would make the CLI think a server is
  // live and then fail to connect, so clear a stale one before binding.
  if (existsSync(socketPath)) rmSync(socketPath, { force: true });

  // The server does not exist yet, and the forwarder needs to reach it: the Rust
  // child starts pushing notifications as soon as it is initialized. A ref keeps
  // the wiring one-directional without ordering the two constructions by hand.
  let appServer = null;
  const forwarder = createForwarder({
    bin: sandboxBin(),
    cwd: process.cwd(),
    onError: (error) => log("[forward]", error.message),
    // fs/changed, account/updated, mcpServer/startupStatus/updated and the rest
    // of the platform's own notifications.
    onNotification: (method, params) => appServer?.broadcast(method, params),
  });

  const server = appServer = await startAppServer({
    socketPath,
    codexHome,
    version,
    sandboxMode,
    threadStore,
    defaultModel,
    threadMode,
    resolveModel,
    // The server is this client's: when the client goes, so does it, unless
    // another connects first (an engine switch or an update relaunches the
    // client within seconds). Left running, it would serve the next client
    // with another account's models and an older release's behaviour.
    onIdle: () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (server?.connections?.() === 0) {
          log(`no client for ${IDLE_EXIT_MS}ms; stopping`);
          shutdown();
        }
      }, IDLE_EXIT_MS);
      idleTimer.unref?.();
    },
    forward: (method, params) => forwarder.forward(method, params),
    onError: (error) => log("[app-server]", error.message),
    onTurnError: (message, { threadId }) => log(`[turn] ${threadId} failed: ${message}`),
    onTrace: (line) => log("[trace]", line),
    createEngineFor: ({ cwd, model, effort, modelProvider, emit, request, sandboxMode: mode, ids, newItemId, resumeState, onState, clientTools, oneShot, mode: variant, permissions, onSteerDelivered, onGoalChanged, onEngineTurn, onScheduledPrompt, onSubagent, onChildActivity, onExecSession, askUser, onCompaction }) =>
      buildEngine({
        // The effective config as codex resolves it for this directory
        // (profiles, project layers): where `[mcp_servers]` comes from.
        readConfig: () => forwarder.forward("config/read", { cwd }),
        // The thread this engine serves (what /status calls the session).
        threadId: ids?.().threadId ?? null,
        oneShot,
        variant,
        permissions,
        modelProvider,
        onSteerDelivered,
        onGoalChanged,
        onEngineTurn,
        onScheduledPrompt,
        onSubagent,
        onChildActivity,
        onExecSession,
        askUser,
        onCompaction,
        cwd,
        model,
        effort,
        sandboxMode: mode,
        resumeState,
        onState,
        clientTools,
        // A client-hosted tool runs in the client: ask it, as the Rust server does.
        callClientTool: ({ callId, namespace, tool, arguments: args }) =>
          request("item/tool/call", { ...ids(), callId, namespace: namespace ?? null, tool, arguments: args ?? {} }),
        onText: (delta) => emit("item/agentMessage/delta", { delta }),
        // /status and the context meter read these.
        onUsage: (tokenUsage) => emit("thread/tokenUsage/updated", { ...ids(), tokenUsage }),
        // The model's todo list, as the client's plan checklist.
        onPlan: (plan) => emit("turn/plan/updated", { ...ids(), explanation: null, plan }),
        onReasoning: (delta) => emit("item/reasoning/textDelta", { delta }),
        // Engine events carry our vocabulary; the client only renders the protocol's.
        onToolEvent: createItemBridge(emit),
        // The user decides, through the client. Fails closed: an unanswered or
        // errored request declines rather than running unapproved.
        requestApproval: createApprovalBridge({
          request,
          cwd,
          ids,
          newItemId,
          timeoutMs: Number(process.env.UNIEAI_APPROVAL_TIMEOUT_MS) || 0,
        }),
      }),
  });

  // Only this user may drive the engine: the socket accepts turns that run
  // commands in the user's workspace.
  chmodSync(socketPath, 0o600);
  // The server outlives the client that started it, so the next client can
  // find it running an older release than itself. This says which release it
  // is and how to stop it (see the TUI's ensure_uac_server).
  const stampPath = `${socketPath}.json`;
  const stamp = {
    pid: process.pid,
    cliVersion: process.env.UNIEAI_CLI_VERSION ?? null,
    // Which account it serves: its models, threads and gateway are that
    // account's, so a client signed in as someone else needs its own.
    accountId: loadCredentials().accountId || null,
    engineVersion: version,
    socket: socketPath,
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    log(`[app-server] could not write ${stampPath}: ${error.message}`);
  }
  log(`${name} app-server ${version} listening on ${socketPath}`);

  const { shutdown, drain } = createStopControls({
    server,
    socketPath,
    stampPath,
    onShutdown,
    onHandOver,
    beforeShutdown: () => forwarder.close(),
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", drain);
  return { server, socketPath, shutdown };
}

/**
 * How a server stops (`shutdown`, SIGINT and the idle exit) and how it hands
 * its socket to a server of another release (`drain`, SIGTERM).
 *
 * SIGTERM is how a client of another release asks for the socket (see the
 * TUI's ensure_uac_server). Stopping then killed the turns other clients were
 * running ("ACP connection closed"), so a server that still has clients only
 * hands the socket over: it removes the socket and stamp, stops listening,
 * gives up whatever else marks it as the socket's server (`onHandOver`: the
 * uac server's `<socket>.lock`), keeps serving the clients it has, and stops
 * once the last of them leaves. From the hand-over on, the socket, stamp and
 * lock paths are the new server's, so the final exit touches none of them.
 *
 * Order matters in the hand-over: closing a listening unix socket unlinks
 * whatever is at its path, so the server is closed before the lock is
 * released; a successor can only bind once it holds the lock, and by then
 * this server can no longer remove its socket.
 */
export function createStopControls({
  server,
  socketPath,
  stampPath,
  onShutdown = async () => {},
  onHandOver = () => {},
  beforeShutdown = () => {},
  exit = (code) => process.exit(code),
}) {
  let stopping = false;
  let draining = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    beforeShutdown();
    await onShutdown().catch((error) => log("[shutdown]", error.message));
    await server.close();
    // After a hand-over these paths are the new server's.
    if (!draining) {
      rmSync(socketPath, { force: true });
      rmSync(stampPath, { force: true });
    }
    exit(0);
  };
  const drain = () => {
    if (stopping || draining) return;
    if (server.connections() === 0) return shutdown();
    draining = true;
    log(`handing the socket over; serving ${server.connections()} client(s) until they leave`);
    rmSync(socketPath, { force: true });
    rmSync(stampPath, { force: true });
    server.close().catch(() => {});
    try {
      onHandOver();
    } catch (error) {
      log("[hand-over]", error.message);
    }
  };
  return { shutdown, drain };
}
