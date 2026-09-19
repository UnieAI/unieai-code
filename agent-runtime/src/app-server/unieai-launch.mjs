// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-launch.mjs — serve the app-server protocol on a unix socket from an engine.
 *
 * Shared by the entry points in bin/: each supplies how a thread's engine is
 * built; the socket, the forwarder to the Rust app-server, and shutdown are the
 * same for all of them.
 */
import { chmodSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { startAppServer } from "./server.mjs";
import { createForwarder } from "./forward.mjs";
import { createItemBridge } from "./items.mjs";
import { createApprovalBridge } from "./approval.mjs";
import { sandboxBin } from "../config.mjs";

export const log = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);

/**
 * `buildEngine({ cwd, model, sandboxMode, resumeState, onState, onText,
 * onReasoning, onToolEvent, requestApproval })` returns an engine for one
 * thread. `threadStore` (see unieai-thread-store.mjs) makes threads persistent.
 * `onShutdown` runs before the process exits.
 */
export async function launchAppServer({ name, version, buildEngine, sandboxMode, threadStore = null, defaultModel = null, threadMode, onShutdown = async () => {} }) {
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
    forward: (method, params) => forwarder.forward(method, params),
    onError: (error) => log("[app-server]", error.message),
    onTrace: (line) => log("[trace]", line),
    createEngineFor: ({ cwd, model, effort, modelProvider, emit, request, sandboxMode: mode, ids, newItemId, resumeState, onState, clientTools, oneShot, mode: variant, permissions, onSteerDelivered, onGoalChanged, onEngineTurn, onSubagent, onChildActivity }) =>
      buildEngine({
        oneShot,
        variant,
        permissions,
        modelProvider,
        onSteerDelivered,
        onGoalChanged,
        onEngineTurn,
        onSubagent,
        onChildActivity,
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
  log(`${name} app-server ${version} listening on ${socketPath}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("shutting down");
    forwarder.close();
    await onShutdown().catch((error) => log("[shutdown]", error.message));
    await server.close();
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, socketPath, shutdown };
}
