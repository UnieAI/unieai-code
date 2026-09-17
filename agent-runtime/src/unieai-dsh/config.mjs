// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * config.mjs — where dsh lives and how it reaches the UnieAI gateway.
 *
 * dsh keeps its own home (settings, sessions). The uac engine gives it a
 * private one under `$CODEX_HOME/uac/dsh-home` and writes a `settings.yaml`
 * there that declares the signed-in gateway as an OpenAI-compatible provider,
 * so dsh uses the same account and models as the rest of UnieAI Code without
 * touching the user's own `~/.dsh`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCredentials, unieaiHome } from "../config.mjs";
import { buildPersona } from "./unieai-persona.mjs";
import { renderPatchParts, selectPlugins as selectCatalogPlugins } from "./uac-plugins/unieai-catalog.mjs";

export const DSH_PROVIDER_ID = "unieai";
export const GATEWAY_KEY_ENV = "UNIEAI_GATEWAY_API_KEY";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The control plugin dsh loads by URL (see unieai-control.mjs). */
export const CONTROL_PLUGIN_URL = pathToFileURL(join(here, "unieai-control.mjs")).href;

/** `bin.js` of the `@deepseek-ai/dsh` this package depends on, if installed. */
export function installedDshBin() {
  try {
    const manifest = require.resolve("@deepseek-ai/dsh/package.json");
    const bin = join(dirname(manifest), "lib", "bin.js");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * The command that starts dsh as an ACP agent.
 *
 * `UNIEAI_DSH_BIN` names either dsh's `bin.js` (run with node) or an
 * executable. Otherwise the pinned `@deepseek-ai/dsh` dependency is used,
 * then `dsh` on PATH.
 */
export function dshCommand(env = process.env) {
  const target = env.UNIEAI_DSH_BIN || installedDshBin();
  const args = ["--profile", "acp"];
  const patch = env.UNIEAI_DSH_PATCH;
  if (patch) args.push("--patch", patch);
  if (!target) return { command: "dsh", args };
  if (/\.[cm]?js$/.test(target)) return { command: process.execPath, args: [target, ...args] };
  return { command: target, args };
}

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(unieaiHome(), "uac", "dsh-home");
}

/** The model the TUI defaults to, from `$CODEX_HOME/config.toml`. */
export function configuredModel(home = unieaiHome()) {
  try {
    const text = readFileSync(join(home, "config.toml"), "utf8");
    // Only the top-level key: stop at the first table header.
    const top = text.split(/^\s*\[/m)[0];
    return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Context window assumed for gateway models that declare none. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Codex retries every dropped stream and honours long Retry-After waits; dsh's
 * default gives up on STREAM_CLOSED / PI_AI_ERROR and on waits over 10s, so a
 * gateway hiccup ends the whole task. INVALID_REQUEST stays non-retryable.
 */
const RETRY_POLICY = {
  maxRetries: 8,
  retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT", "STREAM_CLOSED", "PI_AI_ERROR"],
  initialDelayMs: 1000,
  maxDelayMs: 60000,
};

const yamlQuote = (value) => JSON.stringify(String(value));

/** A gateway model as settings.yaml declares it. */
export function gatewayModel(model) {
  const id = typeof model === "string" ? model : model?.id;
  const contextWindow = Number(model?.context_window ?? model?.contextWindow) || null;
  const declared = model?.input_modalities ?? model?.inputModalities ?? null;
  const input = Array.isArray(declared) ? declared.filter((m) => m === "text" || m === "image") : null;
  return { id, contextWindow, input: input?.length ? input : null };
}

/**
 * dsh's `settings.yaml` for the gateway. YAML is written by hand: flat and quoted.
 *
 * Each model carries what the gateway declared: its context window (else
 * DEFAULT_CONTEXT_WINDOW, so compaction triggers for small models instead of
 * never) and its input modalities (dsh treats an undeclared model as
 * text-only, so read_image would refuse even on a vision model).
 */
export function renderSettings({ baseUrl, models, defaultModel, shellTimeoutMs = 300_000 }) {
  const q = yamlQuote;
  const lines = [
    "# Written by unieai-agent-core (uac) on every start; edits are overwritten.",
    "llm-pi-ai:",
    "  providers:",
    `    ${DSH_PROVIDER_ID}:`,
    `      displayName: ${q("UnieAI")}`,
    `      apiKeyEnv: ${GATEWAY_KEY_ENV}`,
    "      api: openai-completions",
    `      baseURL: ${q(baseUrl)}`,
    `      defaultContextWindow: ${DEFAULT_CONTEXT_WINDOW}`,
    "      retryPolicy:",
    "        mode: normal",
    `        maxRetries: ${RETRY_POLICY.maxRetries}`,
    `        retryableCodes: [${RETRY_POLICY.retryableCodes.join(", ")}]`,
    "        backoff:",
    `          initialDelayMs: ${RETRY_POLICY.initialDelayMs}`,
    `          maxDelayMs: ${RETRY_POLICY.maxDelayMs}`,
    "          jitterRatio: 0.1",
    "      compat:",
    "        supportsDeveloperRole: false",
    "        maxTokensField: max_tokens",
    "      models:",
  ];
  for (const model of models.map(gatewayModel)) {
    lines.push(`        - id: ${q(model.id)}`);
    if (model.contextWindow) lines.push(`          contextWindow: ${model.contextWindow}`);
    if (model.input) lines.push(`          input: [${model.input.join(", ")}]`);
  }
  // Codex yields long commands instead of killing them at 60s. With plain
  // bash the next best thing is a foreground budget that fits a build.
  lines.push(
    "shell:",
    `  timeoutMs: ${shellTimeoutMs}`,
    "  maxTimeoutMs: 1800000",
    "  maxOutputBytes: 1048576",
  );
  if (defaultModel) {
    lines.push("agent-default-model:", `  provider: ${DSH_PROVIDER_ID}`, `  model: ${q(defaultModel)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The plugins uac loads: the `cli` profile of the vendored uac-plugins
 * catalog, narrowed by `UNIEAI_DSH_PLUGINS` (`off`, or a comma list of ids)
 * for A/B runs.
 */
export function selectPlugins(env = process.env) {
  return selectCatalogPlugins({ profile: "cli", env });
}

const indent = (text, spaces) => text.split("\n").map((line) => (line ? " ".repeat(spaces) + line : line)).join("\n");

/**
 * The patch dsh loads last: the ACP route (it ignores `agent-default-model`),
 * the UnieAI persona, harness settings ported from codex, and UnieAI plugins
 * (unieai-control serves what ACP does not). A patch row replaces a row's
 * whole config, so each row restates the fields it keeps.
 */
export function renderPatch({
  defaultModel,
  controlSocket = null,
  pluginUrl = CONTROL_PLUGIN_URL,
  plugins = [],
  acp = true,
  persona = true,
}) {
  const q = yamlQuote;
  const execTools = plugins.some((plugin) => plugin.execTools);
  const lines = [];
  if (acp) {
    lines.push("- id: acp", "  config:", `    provider: ${DSH_PROVIDER_ID}`, `    model: ${q(defaultModel)}`);
  }
  if (persona) {
    const text = buildPersona({ execTools });
    lines.push(
      "- id: system-prompt",
      "  config:",
      "    includeHarnessIdentity: false",
      "    includeRuntimeContext: true",
      "    personaSuffix: \"Your working directory is {{cwd}}.\"",
      "    personaPrefix: |",
      indent(text, 6),
    );
  }
  lines.push(
    // Leave a quarter of the window for reasoning and output, and give the
    // summary room: thinking models truncate an 8k summary.
    "- id: compaction-basic",
    "  config:",
    "    thresholdRatio: 0.75",
    "    retainRatio: 0.15",
    "    maxTokens: 16384",
    "    compactionRetries: 2",
    "    maxOverflowRetries: 2",
    // Codex keeps ~10k tokens of a tool result; dsh inlined 50KB. The spill
    // preview keeps head and tail and the full text stays readable.
    // unieai-exec already cuts to ~44KB itself; don't cut its output twice.
    "- id: spill-policy",
    "  config:",
    `    maxInlineBytes: ${execTools ? 50000 : 24000}`,
    "- id: tool-fs",
    "  config:",
    "    readMaxBytes: 32768",
    "- id: tool-jobs",
    "  config:",
    "    waitTimeoutMs: 60000",
    "    maxWaitTimeoutMs: 1800000",
    "- id: jobs",
    "  config:",
    "    maxConcurrentJobsPerOwner: 16",
    // web_search needs a DeepSeek key uac does not have; don't advertise it.
    "- id: tool-web",
    "  config:",
    "    fetch: true",
    "    search: false",
    "    searchTimeoutMs: 60000",
  );
  const parts = renderPatchParts({ plugins, profile: "cli" });
  lines.push(...parts.rows);
  const inserts = [];
  if (controlSocket) {
    inserts.push(
      "    - id: unieai-control",
      `      name: ${q(pluginUrl)}`,
      "      config:",
      `        socket: ${q(controlSocket)}`,
      `        provider: ${DSH_PROVIDER_ID}`,
      `        model: ${q(defaultModel)}`,
    );
  }
  // The date, appended as a user-role snapshot so the system prefix stays put.
  inserts.push(
    "    - id: time-context",
    "      name: '@deepseek-ai/dsh-time-context'",
    "      config:",
    "        refreshIntervalMs: 1800000",
  );
  inserts.push(...parts.inserts);
  lines.push("- insert:", ...inserts);
  return `${lines.join("\n")}\n`;
}

/**
 * An explicit choice wins; the TUI's configured model only when the gateway
 * serves it (config.toml may name a model from another provider).
 */
export function pickDefaultModel({ explicit, configured, listed }) {
  if (explicit) return explicit;
  if (configured && (listed.length === 0 || listed.includes(configured))) return configured;
  return listed[0] ?? configured ?? null;
}

/** dsh's credential store: refs by env-var name, reloaded on change. */
export function renderCredentials({ apiKey }) {
  return `version: 1\n\nrefs:\n  ${GATEWAY_KEY_ENV}: ${JSON.stringify(String(apiKey))}\n`;
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Point dsh at the signed-in account: its models (as last synced from Studio
 * into unieai.json — the TUI syncs on every launch) and its gateway key.
 * dsh hot-reloads both files, so a running dsh follows a later sync; call this
 * again before each new thread.
 */
export function writeDshAccount({ env = process.env } = {}) {
  const credentials = loadCredentials();
  if (!credentials.signedIn || !credentials.gatewayBaseUrl) {
    throw new Error("unieai-agent-core needs a UnieAI sign-in; run `unieai login` first");
  }
  const home = dshHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const catalog = credentials.models.filter((m) => m?.id);
  const listed = catalog.map((m) => m.id);
  const defaultModel = pickDefaultModel({ explicit: env.UNIEAI_MODEL, configured: configuredModel(), listed });
  if (!defaultModel) {
    throw new Error("no models are available for this UnieAI account; add models in UnieAI Studio");
  }
  const models = [...new Set([defaultModel, ...listed])];
  const declared = models.map((id) => catalog.find((m) => m.id === id) ?? { id });
  writePrivate(join(home, ".credentials.yaml"), renderCredentials({ apiKey: credentials.gatewayApiKey || "" }));
  writeFileSync(join(home, "settings.yaml"), renderSettings({ baseUrl: credentials.gatewayBaseUrl, models: declared, defaultModel }));
  return { home, defaultModel, models };
}

/**
 * Write dsh's home for the account and return the child environment and command.
 * Throws when the user is not signed in: without a gateway dsh has no model.
 */
export function prepareDsh({ env = process.env, sandboxMode = "workspace-write", controlSocket = null } = {}) {
  const { home, defaultModel, models } = writeDshAccount({ env });
  const patchPath = join(home, "uac.patch.yml");
  const plugins = selectPlugins(env);
  writeFileSync(patchPath, renderPatch({ defaultModel, controlSocket, plugins }));

  const childEnv = {
    ...env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: permissionMode(sandboxMode),
    UNIEAI_DSH_PATCH: env.UNIEAI_DSH_PATCH || patchPath,
  };
  // The launch environment outranks the credential store and is frozen at
  // launch, so a key there would pin dsh to it across a Studio key rotation.
  delete childEnv[GATEWAY_KEY_ENV];
  return { env: childEnv, defaultModel, models, controlSocket, plugins: plugins.map((p) => p.id), ...dshCommand(childEnv) };
}

/** The app-server protocol's sandbox names -> dsh's permission modes. */
export function permissionMode(sandboxMode) {
  switch (sandboxMode) {
    case "readOnly":
    case "read-only":
      return "read-only";
    case "dangerFullAccess":
    case "danger-full-access":
      return "danger-full-access";
    default:
      return "workspace-write";
  }
}
