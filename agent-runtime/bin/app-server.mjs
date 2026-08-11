#!/usr/bin/env node
/**
 * app-server.mjs — serve the CLI's app-server protocol from OUR engine.
 *
 * Run this and the `unieai` TUI uses agent-runtime instead of the embedded Rust
 * engine: on startup it probes $CODEX_HOME/app-server-control/app-server-control.sock
 * and prefers whatever is listening there. Stop this process and the CLI silently
 * goes back to the Rust engine, which makes the switch reversible at any moment.
 *
 *   node agent-runtime/bin/app-server.mjs            # serve on the default socket
 *   UNIEAI_APP_SERVER_SOCKET=/tmp/x.sock node …      # somewhere else, for testing
 *
 * Engine methods are answered here; every other method is proxied to
 * `unieai app-server` so the platform surface stays upstream's.
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { startAppServer } from "../src/app-server/server.mjs";
import { createForwarder } from "../src/app-server/forward.mjs";
import { createEngine } from "../src/engine.mjs";
import { createItemBridge } from "../src/app-server/items.mjs";
import { createApprovalBridge } from "../src/app-server/approval.mjs";
import { sandboxBin } from "../src/config.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const codexHome = process.env.CODEX_HOME || process.env.UNIEAI_HOME || join(homedir(), ".unieai");
const socketPath =
  process.env.UNIEAI_APP_SERVER_SOCKET || join(codexHome, "app-server-control", "app-server-control.sock");

mkdirSync(dirname(socketPath), { recursive: true });
// A socket file left by a crashed process would make the CLI think a server is
// live and then fail to connect, so clear a stale one before binding.
if (existsSync(socketPath)) rmSync(socketPath, { force: true });

const log = (...parts) => process.stderr.write(`${parts.join(" ")}\n`);

const forwarder = createForwarder({
  bin: sandboxBin(),
  cwd: process.cwd(),
  onError: (error) => log("[forward]", error.message),
});

const server = await startAppServer({
  socketPath,
  codexHome,
  version,
  forward: (method, params) => forwarder.forward(method, params),
  onError: (error) => log("[app-server]", error.message),
  createEngineFor: ({ cwd, model, emit, request }) => {
    // Engine events carry our vocabulary; the client only renders the protocol's.
    const onToolEvent = createItemBridge(emit);
    return createEngine({
      workspace: cwd,
      model: model || process.env.UNIEAI_MODEL || undefined,
      expectsMutation: true,
      onText: (delta) => emit("item/agentMessage/delta", { delta }),
      onReasoning: (delta) => emit("item/reasoning/textDelta", { delta }),
      onToolEvent,
      // The user decides, through the client. Fails closed: an unanswered or
      // errored request declines rather than running unapproved.
      requestApproval: createApprovalBridge({
        request,
        cwd,
        timeoutMs: Number(process.env.UNIEAI_APPROVAL_TIMEOUT_MS) || 0,
      }),
    });
  },
});

log(`unieai agent-runtime app-server ${version} listening on ${socketPath}`);
log("the unieai CLI will now use this engine; stop this process to fall back to the Rust one");

const shutdown = async () => {
  log("shutting down");
  forwarder.close();
  await server.close();
  rmSync(socketPath, { force: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
