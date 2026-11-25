#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-uac-server.mjs — the unieai-agent-core (uac) engine for `/engine uac`.
 *
 * Answers the app-server protocol's engine methods by driving
 * rabi-harness (`rabi --profile acp`) over the Agent Client Protocol, and
 * forwards every other method to the Rust app-server. The TUI starts this
 * detached on `$CODEX_HOME/uac/app-server.sock` when the engine is `uac`
 * (codex-rs/tui/src/unieai_engine.rs); it keeps running for later launches.
 *
 *   UNIEAI_APP_SERVER_SOCKET=/tmp/uac.sock node agent-runtime/bin/unieai-uac-server.mjs
 *
 * Environment:
 *   UNIEAI_RABI_BIN    rabi's bin.js or executable (default: the pinned
 *                      @unieai/rabi dependency, then `rabi` on PATH)
 *   UNIEAI_RABI_PATCH  extra cordis patch for rabi (default: generated)
 *   UNIEAI_MODEL       default model (default: config.toml `model`)
 *   UNIEAI_SANDBOX     read-only | workspace-write | danger-full-access
 *   RABI_HOME          rabi's home (default: $CODEX_HOME/uac/rabi-home)
 *   UNIEAI_UAC_MODE    rabi mode for new threads (default: $CODEX_HOME/uac/mode,
 *                      then standard): standard | ptc | cordis | minimal
 *
 * The names from before the Rabi rename still work (src/unieai-rabi/rabi-legacy.mjs).
 *
 * Each rabi mode runs in its own rabi process, started when a thread first
 * needs it; a thread keeps the mode it started in.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launchAppServer, log } from "../src/app-server/unieai-launch.mjs";
import { createThreadStore } from "../src/app-server/unieai-thread-store.mjs";
import { createAcpConnection, spawnAcpAgent } from "../src/unieai-rabi/acp-client.mjs";
import {
  LOCAL_PROVIDERS,
  configuredUacMode,
  fetchLocalModels,
  loadSelfHostedProviders,
  localProviderBaseUrl,
  prepareRabi,
  routeModel,
  selfHostedKey,
  selfHostedKeyEnv,
  writeRabiAccount,
} from "../src/unieai-rabi/config.mjs";
import { createRabiEngine, createRabiHost } from "../src/unieai-rabi/engine.mjs";
import { loadCredentials } from "../src/config.mjs";
import { acpMcpServers, attachOAuthTokens, sessionMcpServers, storedOAuthAccessToken, studioMcpServer } from "../src/unieai-rabi/unieai-mcp-servers.mjs";
import { codexTokenSource, createMcpAuthProxy } from "../src/unieai-rabi/unieai-mcp-auth-proxy.mjs";
import { agentFailureReason } from "../src/unieai-rabi/acp-client.mjs";
import { createOneShotEngine, createOneShotModel } from "../src/unieai-rabi/unieai-oneshot.mjs";
import { claimServer } from "../src/unieai-rabi/unieai-server-lock.mjs";
import { IS_WINDOWS, nodeSocketEndpoint } from "../src/app-server/unieai-local-endpoint.mjs";
import { adoptLegacyEnv } from "../src/unieai-rabi/rabi-legacy.mjs";

adoptLegacyEnv(process.env);

// A thread on a self-hosted model titles itself on that server: no UnieAI
// sign-in is needed, and nothing about it reaches the gateway.
const oneShotCall = createOneShotModel({
  route: (model) => {
    const { server, model: id } = routeModel(model, loadSelfHostedProviders());
    return server ? { baseUrl: server.baseUrl, apiKey: selfHostedKey(server), model: id } : null;
  },
});
// Logged with its duration: the client gives these turns 30 seconds.
const oneShotModel = async (request) => {
  const started = Date.now();
  try {
    return await oneShotCall(request);
  } finally {
    log(`[rabi] one-shot ${request.model} answered in ${Date.now() - started} ms`);
  }
};

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
// The installed UnieAI Code package (agent-runtime/bin/ is two levels below it).
const INSTALL_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");

// rabi-harness uses Node 22 APIs (Promise.withResolvers, …); say so plainly
// instead of failing inside rabi. The TUI falls back to codex and names this log.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  log(`uac needs Node.js 22 or newer; this is ${process.version}. Set UNIEAI_NODE to a newer node.`);
  process.exit(1);
}

const sandboxMode = process.env.UNIEAI_SANDBOX || "workspace-write";
const codexHome = process.env.CODEX_HOME || process.env.UNIEAI_HOME || join(homedir(), ".unieai");
const appSocket = process.env.UNIEAI_APP_SERVER_SOCKET || join(codexHome, "uac", "app-server.sock");
// One server per socket. Two TUIs opened together each start one; the second
// must not start a rabi of its own next to the first one's (see
// unieai-server-lock.mjs). It waits for the first to answer and leaves, which
// is what its TUI is waiting for. A server that hands the socket over to
// another release (unieai-launch's drain) gives up the lock with it, so the
// new release's server can take both while this one serves its clients.
mkdirSync(dirname(appSocket), { recursive: true });
const claimed = await claimServer(appSocket).catch((error) => {
  log(`rabi: ${error.message}`);
  process.exit(1);
});
if (!claimed.release) {
  log(`rabi: another server is already serving ${appSocket}; this one is not needed`);
  process.exit(0);
}
process.once("exit", claimed.release);

// Next to the app-server socket, whose path the TUI already kept short. The
// pid keeps it this process's: a server of another release can start while
// this one still serves its clients (see unieai-launch's drain), and a shared
// path would hand this server's rabi control channel to the new one's rabi.
// On Windows the path only names it: Node serves no unix sockets there, so
// both ends use the named pipe derived from it (unieai-local-endpoint.mjs).
const controlSocketPathFor = (mode) =>
  appSocket.replace(/(\.sock)?$/, mode === "standard" ? `.${process.pid}.rabi.sock` : `.${process.pid}.${mode}.rabi.sock`);
const controlSocketFor = (mode) => nodeSocketEndpoint(controlSocketPathFor(mode));
removeStaleControlSockets(dirname(appSocket));

/** Control sockets of uac servers that are no longer running. */
function removeStaleControlSockets(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^app-server\.(\d+)\..*rabi\.sock$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") rmSync(join(dir, name), { force: true });
    }
  }
}
// Fail at startup, where the TUI reports it, rather than on the first turn.
const rabi = prepareRabi({ sandboxMode, controlSocket: controlSocketFor("standard") });
log(`rabi: command = ${rabi.command} ${rabi.args.join(" ")} (home ${rabi.env.RABI_HOME}, model ${rabi.defaultModel})`);

/**
 * One auth proxy for this server process, made on first use. It refreshes
 * through the latest thread's probe; every probe reaches the same Rust side.
 */
let authProxy = null;
let refreshProbe = null;
function mcpAuthProxy(probe) {
  refreshProbe = probe;
  authProxy ??= createMcpAuthProxy({
    log,
    getToken: codexTokenSource({
      read: (name, url, marginMs) => storedOAuthAccessToken({ home: codexHome, name, url, marginMs }),
      refresh: (name) => refreshProbe?.(name),
    }),
  });
  return authProxy;
}

const hosts = new Map(); // mode -> rabi host

/** The rabi process for `mode`, started on first use. */
function hostFor(mode = "standard") {
  const existing = hosts.get(mode);
  if (existing) return existing;
  const controlSocket = controlSocketFor(mode);
  const setup = mode === "standard" ? rabi : prepareRabi({ sandboxMode, controlSocket, mode });
  // rabi's recent stderr: when it dies, its own error (a missing export, a bad
  // patch) is what the user needs, not "the connection closed".
  const stderr = [];
  const tag = mode === "standard" ? "[rabi]" : `[rabi:${mode}]`;
  const host = createRabiHost({
    onLog: (line) => log("[rabi]", line),
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
        // macOS kills a process outright when a native addon it loads is quarantined or its
        // signature does not check out; the process says nothing, only the signal shows.
        const macKilled =
          process.platform === "darwin" && /killed by SIGKILL/.test(error.message)
            ? ` macOS stopped it, usually because files from a downloaded bundle are quarantined: run \`xattr -dr com.apple.quarantine "${INSTALL_ROOT}"\` and start again.`
            : "";
        throw new Error(
          `rabi-harness (rabi, ${mode} mode) failed to start${reason ? `: ${reason}` : `: ${error.message}`}.${macKilled} ` +
            "Reinstall UnieAI Code if it persists; details are in the Rabi Harness server log.",
        );
      }
    },
    connectControl: () => connectControlSocket(controlSocket),
  });
  hosts.set(mode, host);
  // Start rabi now so a broken install shows up in the log before the first turn.
  host.agent().then(
    (acp) => log(`rabi: ${mode} mode ready (${acp.agentInfo?.name ?? "acp agent"} ${acp.agentInfo?.version ?? ""})`),
    (error) => log(`rabi: ${mode} mode failed to start: ${error.message}`),
  );
  return host;
}

const threadMode = () => configuredUacMode({ home: codexHome });

/**
 * Local model servers threads have asked for (`--oss`, `--local-provider`),
 * by provider id. Every one stays declared in rabi's settings for the life of
 * the server: settings are rewritten per thread, and dropping a provider
 * would cut off a thread still using it.
 */
const localProviders = new Map();
/** config.toml `[model_providers]` threads asked for, declared the same way. */
const configuredProviders = new Map();
const writeAccount = () =>
  writeRabiAccount({ localProviders: [...localProviders.values()], providers: [...configuredProviders.values()] });

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
  log(`[rabi] local provider ${id} at ${baseUrl}: ${models.join(", ")}`);
  return models;
}

/**
 * Declare config.toml's `[model_providers.<id>]` (codex's own mechanism) for a
 * thread on that provider: rabi speaks chat completions to its `base_url`,
 * with the key from its `env_key` (or `experimental_bearer_token`).
 */
async function declareConfiguredProvider(id, info) {
  const baseUrl = String(info?.base_url ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error(`model provider ${id} has no base_url in config.toml`);
  const keyValue = (info.env_key ? process.env[info.env_key] : null) || info.experimental_bearer_token || null;
  let models;
  try {
    models = await fetchLocalModels(baseUrl, { apiKey: keyValue });
  } catch (error) {
    throw new Error(`model provider ${id} is not reachable at ${baseUrl}: ${error.message}`);
  }
  configuredProviders.set(id, {
    id,
    displayName: info.name || id,
    baseUrl,
    keyEnv: selfHostedKeyEnv(id),
    keyValue,
    models: models.map((model) => ({ id: model, contextWindow: null, input: null })),
  });
  writeAccount();
  log(`[rabi] config provider ${id} at ${baseUrl}: ${models.join(", ")}`);
  return models;
}
hostFor(threadMode());

/** The unieai-control plugin listens once rabi has loaded it; wait briefly for it. */
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
  name: "unieai-agent-core",
  version,
  // The protocol spells it `readOnly`; what the client is told must match rabi.
  sandboxMode: sandboxMode === "read-only" ? "readOnly" : sandboxMode,
  // rabi sessions persist, so uac threads do too: listed, resumed, forked.
  threadStore: createThreadStore(join(codexHome, "uac", "threads.json")),
  defaultModel: rabi.defaultModel,
  threadMode,
  // Handing the socket to another release's server hands it the lock too.
  onHandOver: claimed.release,
  onShutdown: async () => {
    await Promise.all([...hosts.values()].map((host) => host.close()));
    // A named pipe goes with its listener; only unix socket files linger.
    if (!IS_WINDOWS) for (const mode of hosts.keys()) rmSync(controlSocketFor(mode), { force: true });
  },
  // What this account can actually run: a model it does not offer (a config
  // written for another account — Studio's ids differ from Rabi's) becomes
  // its default, so the client shows the model the turns run on.
  resolveModel: (model) => {
    if (!model) return model;
    try {
      const account = writeAccount();
      if (account.models.includes(model)) return model;
      log(`[rabi] this account does not offer "${model}"; using ${account.defaultModel}`);
      return account.defaultModel;
    } catch {
      return model;
    }
  },
  buildEngine: ({ cwd, model, modelProvider, sandboxMode: _mode, oneShot, variant, readConfig, probeMcpServer, ...callbacks }) => {
    // The user's `[mcp_servers]` and Studio's (knowledge bases, SQL, skills),
    // read when each session opens so a config edit or new sign-in counts.
    const mcpServers = async () => {
      const { config } = (await readConfig?.()) ?? {};
      const { servers: converted, skipped } = acpMcpServers(config?.mcp_servers);
      for (const reason of skipped) log("[rabi] MCP server skipped:", reason);
      // OAuth servers go through the auth proxy, which puts codex's current
      // token on every request and has the Rust side refresh it when due.
      const { servers, notes } = probeMcpServer
        ? await attachOAuthTokens(converted, {
            configured: config?.mcp_servers,
            probe: probeMcpServer,
            readToken: (name, url) => storedOAuthAccessToken({ home: codexHome, name, url }),
            route: (server) => mcpAuthProxy(probeMcpServer).route(server),
          })
        : { servers: converted, notes: [] };
      for (const note of notes) log("[rabi] MCP server", note);
      return sessionMcpServers({ configured: servers, studio: studioMcpServer(loadCredentials()) });
    };
    // The TUI re-synced unieai.json with Studio when it launched; carry that
    // into rabi's hot-reloaded settings before this thread picks a model.
    let account = rabi;
    try {
      account = writeAccount();
    } catch (error) {
      log("[rabi] could not refresh the account for rabi:", error.message);
    }
    const selfHosted = account.selfHosted ?? loadSelfHostedProviders();
    // A thread whose provider is a self-hosted server itself (config.toml
    // `model_provider = "<id>"`) names the server's model bare.
    const ownServer = selfHosted.find((server) => server.id === modelProvider);
    if (ownServer && model && !model.startsWith(`${ownServer.id}/`)) model = `${ownServer.id}/${model}`;
    // Already resolved by `resolveModel` for threads the client started;
    // a stored thread's model is checked again here.
    const chosen = model && account.models.includes(model) ? model : account.defaultModel;
    // The client's hidden structured turns (thread titles): one tool-less call.
    if (oneShot) return createOneShotEngine({ oneShot: oneShotModel, model: chosen, onText: callbacks.onText });
    // Where a model runs: a self-hosted server's `<server>/<model>`, else the gateway.
    const route = (slug) => {
      const { provider, model: id } = routeModel(slug, loadSelfHostedProviders());
      return { provider, model: id };
    };
    // config.toml `[model_providers.<id>]` that is none of the above: declare
    // it from the config before the first session.
    if (modelProvider && modelProvider !== "unieai" && !LOCAL_PROVIDERS[modelProvider] && !ownServer) {
      return createRabiEngine({
        host: hostFor(variant ?? "standard"),
        workspace: cwd,
        model,
        provider: modelProvider,
        prepare: async () => {
          const { config } = (await readConfig?.()) ?? {};
          const info = config?.model_providers?.[modelProvider];
          if (!info) throw new Error(`model provider ${modelProvider} is not defined in config.toml`);
          return declareConfiguredProvider(modelProvider, info);
        },
        onLog: (line) => log("[rabi]", line),
        mcpServers,
        ...callbacks,
      });
    }
    // A local model server (--oss / --local-provider): the thread's model
    // comes from it, declared in rabi before the first session.
    if (LOCAL_PROVIDERS[modelProvider]) {
      return createRabiEngine({
        host: hostFor(variant ?? "standard"),
        workspace: cwd,
        model,
        provider: modelProvider,
        prepare: () => declareLocalProvider(modelProvider),
        onLog: (line) => log("[rabi]", line),
        mcpServers,
        ...callbacks,
      });
    }
    const routed = route(chosen);
    return createRabiEngine({
      // Threads stored before modes existed have none: standard.
      host: hostFor(variant ?? "standard"),
      workspace: cwd,
      model: routed.model,
      provider: routed.provider,
      routeModel: route,
      onLog: (line) => log("[rabi]", line),
      mcpServers,
      ...callbacks,
    });
  },
});
