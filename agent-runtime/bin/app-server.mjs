#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * app-server.mjs — serve the CLI's app-server protocol from agent-runtime's
 * own agent-core loop.
 *
 * Run this and the `unieai` TUI uses agent-runtime instead of the embedded Rust
 * engine: on startup it probes $CODEX_HOME/app-server-control/app-server-control.sock
 * and prefers whatever is listening there. Stop this process and the CLI silently
 * goes back to the Rust engine, which makes the switch reversible at any moment.
 *
 *   node agent-runtime/bin/app-server.mjs            # serve on the default socket
 *   UNIEAI_APP_SERVER_SOCKET=/tmp/x.sock node …      # somewhere else, for testing
 *
 * The `/engine` command does not use this entry point; it runs
 * unieai-uac-server.mjs (deepseek-harness) on its own socket.
 *
 * Engine methods are answered here; every other method is proxied to
 * `unieai app-server` so the platform surface stays upstream's.
 */
import { createRequire } from "node:module";
import { createEngine } from "../src/engine.mjs";
import { launchAppServer, log } from "../src/app-server/unieai-launch.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

await launchAppServer({
  name: "unieai agent-runtime",
  version,
  buildEngine: ({ cwd, model, sandboxMode, ...callbacks }) =>
    createEngine({
      workspace: cwd,
      model: model || process.env.UNIEAI_MODEL || undefined,
      expectsMutation: true,
      sandboxMode,
      ...callbacks,
    }),
});
log("the unieai CLI will now use this engine; stop this process to fall back to the Rust one");
