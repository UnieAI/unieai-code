#!/usr/bin/env node
/**
 * uac-app-server.mjs — the unieai-agent-core (uac) engine for `/engine uac`.
 *
 * Answers the app-server protocol's engine methods by driving
 * deepseek-harness (`dsh --profile acp`) over the Agent Client Protocol, and
 * forwards every other method to the Rust app-server. The TUI starts this
 * detached on `$CODEX_HOME/uac/app-server.sock` when the engine is `uac`
 * (codex-rs/tui/src/engine_selection.rs); it keeps running for later launches.
 *
 *   UNIEAI_APP_SERVER_SOCKET=/tmp/uac.sock node agent-runtime/bin/uac-app-server.mjs
 *
 * Environment:
 *   UNIEAI_DSH_BIN     dsh's bin.js or executable (default: the pinned
 *                      @deepseek-ai/dsh dependency, then `dsh` on PATH)
 *   UNIEAI_DSH_PATCH   extra cordis patch for dsh (default: generated)
 *   UNIEAI_MODEL       default model (default: config.toml `model`)
 *   UNIEAI_SANDBOX     read-only | workspace-write | danger-full-access
 *   DSH_HOME           dsh's home (default: $CODEX_HOME/uac/dsh-home)
 */
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchAppServer, log } from "../src/app-server/launch.mjs";
import { createThreadStore } from "../src/app-server/thread-store.mjs";
import { createAcpConnection, spawnAcpAgent } from "../src/dsh/acp-client.mjs";
import { prepareDsh, writeDshAccount } from "../src/dsh/config.mjs";
import { createDshEngine, createDshHost } from "../src/dsh/engine.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const sandboxMode = process.env.UNIEAI_SANDBOX || "workspace-write";
const codexHome = process.env.CODEX_HOME || process.env.UNIEAI_HOME || join(homedir(), ".unieai");
const appSocket = process.env.UNIEAI_APP_SERVER_SOCKET || join(codexHome, "uac", "app-server.sock");
// Next to the app-server socket, whose path the TUI already kept short.
const controlSocket = appSocket.replace(/(\.sock)?$/, ".dsh.sock");
// Fail at startup, where the TUI reports it, rather than on the first turn.
const dsh = prepareDsh({ sandboxMode, controlSocket });
log(`uac: dsh = ${dsh.command} ${dsh.args.join(" ")} (home ${dsh.env.DSH_HOME}, model ${dsh.defaultModel})`);

const host = createDshHost({
  onLog: (line) => log("[uac]", line),
  connect: () =>
    spawnAcpAgent({
      command: dsh.command,
      args: dsh.args,
      env: dsh.env,
      cwd: process.cwd(),
      onLog: (line) => log("[dsh]", line),
    }),
  connectControl: () => connectControlSocket(controlSocket),
});

/** The uac-control plugin listens once dsh has loaded it; wait briefly for it. */
async function connectControlSocket(path, { attempts = 40, intervalMs = 250 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = connect(path, () => resolve(s));
        s.once("error", reject);
      });
      return createAcpConnection({ input: socket, output: socket, onError: (error) => log("[uac-control]", error.message) });
    } catch (error) {
      if (attempt >= attempts) throw new Error(`uac-control is not reachable at ${path}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
// Start dsh now so a broken install shows up in the log before the first turn.
host.agent().then(
  (acp) => log(`uac: dsh ready (${acp.agentInfo?.name ?? "acp agent"} ${acp.agentInfo?.version ?? ""})`),
  (error) => log(`uac: dsh failed to start: ${error.message}`),
);

await launchAppServer({
  name: "unieai-agent-core (uac)",
  version,
  // The protocol spells it `readOnly`; what the client is told must match dsh.
  sandboxMode: sandboxMode === "read-only" ? "readOnly" : sandboxMode,
  // dsh sessions persist, so uac threads do too: listed, resumed, forked.
  threadStore: createThreadStore(join(codexHome, "uac", "threads.json")),
  defaultModel: dsh.defaultModel,
  onShutdown: () => host.close(),
  buildEngine: ({ cwd, model, sandboxMode: _mode, ...callbacks }) => {
    // The TUI re-synced unieai.json with Studio when it launched; carry that
    // into dsh's hot-reloaded settings before this thread picks a model.
    let account = dsh;
    try {
      account = writeDshAccount();
    } catch (error) {
      log("[uac] could not refresh the account for dsh:", error.message);
    }
    return createDshEngine({
      host,
      workspace: cwd,
      model: model && account.models.includes(model) ? model : account.defaultModel,
      onLog: (line) => log("[uac]", line),
      ...callbacks,
    });
  },
});
