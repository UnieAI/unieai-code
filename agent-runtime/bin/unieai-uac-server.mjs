#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-uac-server.mjs — the unieai-agent-core (uac) engine for `/engine uac`.
 *
 * Answers the app-server protocol's engine methods by driving
 * deepseek-harness (`dsh --profile acp`) over the Agent Client Protocol, and
 * forwards every other method to the Rust app-server. The TUI starts this
 * detached on `$CODEX_HOME/uac/app-server.sock` when the engine is `uac`
 * (codex-rs/tui/src/unieai_engine.rs); it keeps running for later launches.
 *
 *   UNIEAI_APP_SERVER_SOCKET=/tmp/uac.sock node agent-runtime/bin/unieai-uac-server.mjs
 *
 * Environment:
 *   UNIEAI_DSH_BIN     dsh's bin.js or executable (default: the pinned
 *                      @deepseek-ai/dsh dependency, then `dsh` on PATH)
 *   UNIEAI_DSH_PATCH   extra cordis patch for dsh (default: generated)
 *   UNIEAI_MODEL       default model (default: config.toml `model`)
 *   UNIEAI_SANDBOX     read-only | workspace-write | danger-full-access
 *   DSH_HOME           dsh's home (default: $CODEX_HOME/uac/dsh-home)
 *   UNIEAI_UAC_MODE    dsh mode for new threads (default: $CODEX_HOME/uac/mode,
 *                      then standard): standard | ptc | cordis | minimal
 *
 * Each dsh mode runs in its own dsh process, started when a thread first
 * needs it; a thread keeps the mode it started in.
 */
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchAppServer, log } from "../src/app-server/unieai-launch.mjs";
import { createThreadStore } from "../src/app-server/unieai-thread-store.mjs";
import { createAcpConnection, spawnAcpAgent } from "../src/unieai-dsh/acp-client.mjs";
import {
  LOCAL_PROVIDERS,
  configuredUacMode,
  fetchLocalModels,
  localProviderBaseUrl,
  prepareDsh,
  writeDshAccount,
} from "../src/unieai-dsh/config.mjs";
import { createDshEngine, createDshHost } from "../src/unieai-dsh/engine.mjs";
import { loadCredentials } from "../src/config.mjs";
import { acpMcpServers, sessionMcpServers, studioMcpServer } from "../src/unieai-dsh/unieai-mcp-servers.mjs";
import { agentFailureReason } from "../src/unieai-dsh/acp-client.mjs";
import { createOneShotEngine, createOneShotModel } from "../src/unieai-dsh/unieai-oneshot.mjs";

const oneShotCall = createOneShotModel();
// Logged with its duration: the client gives these turns 30 seconds.
const oneShotModel = async (request) => {
  const started = Date.now();
  try {
    return await oneShotCall(request);
  } finally {
    log(`[uac] one-shot ${request.model} answered in ${Date.now() - started} ms`);
  }
};

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// deepseek-harness uses Node 22 APIs (Promise.withResolvers, …); say so plainly
// instead of failing inside dsh. The TUI falls back to codex and names this log.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  log(`uac needs Node.js 22 or newer; this is ${process.version}. Set UNIEAI_NODE to a newer node.`);
  process.exit(1);
}

const sandboxMode = process.env.UNIEAI_SANDBOX || "workspace-write";
const codexHome = process.env.CODEX_HOME || process.env.UNIEAI_HOME || join(homedir(), ".unieai");
const appSocket = process.env.UNIEAI_APP_SERVER_SOCKET || join(codexHome, "uac", "app-server.sock");
// Next to the app-server socket, whose path the TUI already kept short.
// Next to the app-server socket, whose path the TUI already kept short.
const controlSocketFor = (mode) => appSocket.replace(/(\.sock)?$/, mode === "standard" ? ".dsh.sock" : `.${mode}.dsh.sock`);
// Fail at startup, where the TUI reports it, rather than on the first turn.
const dsh = prepareDsh({ sandboxMode, controlSocket: controlSocketFor("standard") });
log(`uac: dsh = ${dsh.command} ${dsh.args.join(" ")} (home ${dsh.env.DSH_HOME}, model ${dsh.defaultModel})`);

const hosts = new Map(); // mode -> dsh host

/** The dsh process for `mode`, started on first use. */
function hostFor(mode = "standard") {
  const existing = hosts.get(mode);
  if (existing) return existing;
  const controlSocket = controlSocketFor(mode);
  const setup = mode === "standard" ? dsh : prepareDsh({ sandboxMode, controlSocket, mode });
  // dsh's recent stderr: when it dies, its own error (a missing export, a bad
  // patch) is what the user needs, not "the connection closed".
  const stderr = [];
  const tag = mode === "standard" ? "[dsh]" : `[dsh:${mode}]`;
  const host = createDshHost({
    onLog: (line) => log("[uac]", line),
    connect: async () => {
      try {
        return await spawnAcpAgent({
          command: setup.command,
          args: setup.args,
          env: setup.env,
          cwd: process.cwd(),
          onLog: (line) => {
            stderr.push(line);
            if (stderr.length > 40) stderr.shift();
            log(tag, line);
          },
        });
      } catch (error) {
        const reason = agentFailureReason(stderr);
        throw new Error(
          `deepseek-harness (dsh, ${mode} mode) failed to start${reason ? `: ${reason}` : `: ${error.message}`}. ` +
            "Reinstall UnieAI Code if it persists; details are in the uac server log.",
        );
      }
    },
    connectControl: () => connectControlSocket(controlSocket),
  });
  hosts.set(mode, host);
  // Start dsh now so a broken install shows up in the log before the first turn.
  host.agent().then(
    (acp) => log(`uac: dsh ${mode} ready (${acp.agentInfo?.name ?? "acp agent"} ${acp.agentInfo?.version ?? ""})`),
    (error) => log(`uac: dsh ${mode} failed to start: ${error.message}`),
  );
  return host;
}

const threadMode = () => configuredUacMode({ home: codexHome });

/**
 * Local model servers threads have asked for (`--oss`, `--local-provider`),
 * by provider id. Every one stays declared in dsh's settings for the life of
 * the server: settings are rewritten per thread, and dropping a provider
 * would cut off a thread still using it.
 */
const localProviders = new Map();
const writeAccount = () => writeDshAccount({ localProviders: [...localProviders.values()] });

/** Declare the local provider `id` with the models it serves now. */
async function declareLocalProvider(id) {
  const baseUrl = localProviderBaseUrl(id);
  let models;
  try {
    models = await fetchLocalModels(baseUrl);
  } catch (error) {
    throw new Error(`${LOCAL_PROVIDERS[id].displayName} is not reachable at ${baseUrl}: ${error.message}`);
  }
  if (models.length === 0) throw new Error(`${LOCAL_PROVIDERS[id].displayName} at ${baseUrl} serves no models; pull one first`);
  localProviders.set(id, { id, baseUrl, models });
  writeAccount();
  log(`[uac] local provider ${id} at ${baseUrl}: ${models.join(", ")}`);
  return models;
}
hostFor(threadMode());

/** The unieai-control plugin listens once dsh has loaded it; wait briefly for it. */
async function connectControlSocket(path, { attempts = 40, intervalMs = 250 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = connect(path, () => resolve(s));
        s.once("error", reject);
      });
      return createAcpConnection({ input: socket, output: socket, onError: (error) => log("[unieai-control]", error.message) });
    } catch (error) {
      if (attempt >= attempts) throw new Error(`unieai-control is not reachable at ${path}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

await launchAppServer({
  name: "unieai-agent-core (uac)",
  version,
  // The protocol spells it `readOnly`; what the client is told must match dsh.
  sandboxMode: sandboxMode === "read-only" ? "readOnly" : sandboxMode,
  // dsh sessions persist, so uac threads do too: listed, resumed, forked.
  threadStore: createThreadStore(join(codexHome, "uac", "threads.json")),
  defaultModel: dsh.defaultModel,
  threadMode,
  onShutdown: () => Promise.all([...hosts.values()].map((host) => host.close())),
  // What this account can actually run: a model it does not offer (a config
  // written for another account — Studio's ids differ from Rabi's) becomes
  // its default, so the client shows the model the turns run on.
  resolveModel: (model) => {
    if (!model) return model;
    try {
      const account = writeAccount();
      if (account.models.includes(model)) return model;
      log(`[uac] this account does not offer "${model}"; using ${account.defaultModel}`);
      return account.defaultModel;
    } catch {
      return model;
    }
  },
  buildEngine: ({ cwd, model, modelProvider, sandboxMode: _mode, oneShot, variant, readConfig, ...callbacks }) => {
    // The user's `[mcp_servers]` and Studio's (knowledge bases, SQL, skills),
    // read when each session opens so a config edit or new sign-in counts.
    const mcpServers = async () => {
      const { config } = (await readConfig?.()) ?? {};
      const { servers, skipped } = acpMcpServers(config?.mcp_servers);
      for (const reason of skipped) log("[uac] MCP server skipped:", reason);
      return sessionMcpServers({ configured: servers, studio: studioMcpServer(loadCredentials()) });
    };
    // The TUI re-synced unieai.json with Studio when it launched; carry that
    // into dsh's hot-reloaded settings before this thread picks a model.
    let account = dsh;
    try {
      account = writeAccount();
    } catch (error) {
      log("[uac] could not refresh the account for dsh:", error.message);
    }
    // Already resolved by `resolveModel` for threads the client started;
    // a stored thread's model is checked again here.
    const chosen = model && account.models.includes(model) ? model : account.defaultModel;
    // The client's hidden structured turns (thread titles): one tool-less call.
    if (oneShot) return createOneShotEngine({ oneShot: oneShotModel, model: chosen, onText: callbacks.onText });
    // A local model server (--oss / --local-provider): the thread's model
    // comes from it, declared in dsh before the first session.
    if (LOCAL_PROVIDERS[modelProvider]) {
      return createDshEngine({
        host: hostFor(variant ?? "standard"),
        workspace: cwd,
        model,
        provider: modelProvider,
        prepare: () => declareLocalProvider(modelProvider),
        onLog: (line) => log("[uac]", line),
        mcpServers,
        ...callbacks,
      });
    }
    return createDshEngine({
      // Threads stored before modes existed have none: standard.
      host: hostFor(variant ?? "standard"),
      workspace: cwd,
      model: chosen,
      onLog: (line) => log("[uac]", line),
      mcpServers,
      ...callbacks,
    });
  },
});
