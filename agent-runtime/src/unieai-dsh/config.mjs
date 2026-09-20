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
/** Local model servers `--oss` / `--local-provider` select, by codex's provider id. */
export const LOCAL_PROVIDERS = Object.freeze({
  ollama: { displayName: "Ollama (local)", port: 11434 },
  lmstudio: { displayName: "LM Studio (local)", port: 1234 },
});

/** Where a local provider listens: codex's CODEX_OSS_BASE_URL / CODEX_OSS_PORT, else its default port. */
export function localProviderBaseUrl(id, env = process.env) {
  if (env.CODEX_OSS_BASE_URL?.trim()) return env.CODEX_OSS_BASE_URL.trim().replace(/\/+$/, "");
  const port = Number.parseInt(env.CODEX_OSS_PORT ?? "", 10) || LOCAL_PROVIDERS[id]?.port;
  return `http://localhost:${port}/v1`;
}

/** The models a local OpenAI-compatible server offers (`GET /models`). */
export async function fetchLocalModels(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  const response = await fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${baseUrl}/models answered HTTP ${response.status}`);
  const body = await response.json();
  return (body?.data ?? body?.models ?? []).map((entry) => entry?.id ?? entry?.name).filter(Boolean);
}

export function renderSettings({ baseUrl, models, defaultModel, shellTimeoutMs = 300_000, localProviders = [] }) {
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
  // Local servers need no key; their windows are unknown, so a
  // conservative default keeps compaction ahead of the server's limit.
  for (const local of localProviders) {
    lines.push(
      `    ${local.id}:`,
      `      displayName: ${q(LOCAL_PROVIDERS[local.id]?.displayName ?? local.id)}`,
      `      apiKeyEnv: ${LOCAL_KEY_ENV}`,
      "      api: openai-completions",
      `      baseURL: ${q(local.baseUrl)}`,
      "      defaultContextWindow: 32768",
      "      compat:",
      "        supportsDeveloperRole: false",
      "        maxTokensField: max_tokens",
      "      models:",
      ...local.models.map((id) => `        - id: ${q(id)}`),
    );
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
 * dsh's agent modes, as its web app offers them (`dsh-agent-presets`): the
 * ACP profile uac runs is `standard` laid out flat, so each other mode is a
 * patch on top of it.
 *
 *   standard  the full coding agent
 *   ptc       tools presented as a TypeScript SDK the model drives with one
 *             `run_code` program, instead of one round trip per tool
 *   cordis    standard plus runtime inspection and composition authoring
 *   minimal   one persistent shell and nothing else
 */
export const UAC_MODES = Object.freeze(["standard", "ptc", "cordis", "minimal"]);

export function parseUacMode(raw) {
  const mode = String(raw ?? "").trim().toLowerCase();
  if (mode === "creator" || mode === "創造") return "cordis";
  return UAC_MODES.includes(mode) ? mode : null;
}

/**
 * The mode new threads use: `UNIEAI_UAC_MODE`, else what `/engine` saved in
 * `$CODEX_HOME/uac/mode`, else standard. Read per thread, so a switch applies
 * to the next session without restarting the server.
 */
export function configuredUacMode({ env = process.env, home = unieaiHome() } = {}) {
  const fromEnv = parseUacMode(env.UNIEAI_UAC_MODE);
  if (fromEnv) return fromEnv;
  try {
    return parseUacMode(readFileSync(join(home, "uac", "mode"), "utf8")) ?? "standard";
  } catch {
    return "standard";
  }
}

/** unieai plugins that add tools; minimal mode has only its shell. */
const TOOL_PLUGINS = new Set([
  "unieai-exec",
  "unieai-edit-observe",
  "unieai-skills",
  "unieai-edit-rescue",
  "unieai-edit-feedback",
  "unieai-apply-patch",
  "unieai-web-search",
  "unieai-vision-fallback",
  "unieai-wait-agents",
]);

/** The ACP profile's tool rows that minimal mode turns off. */
const MINIMAL_DISABLED = [
  "tool-bash",
  "tool-pwsh",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "tool-skill",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "tool-workflow",
  "tool-todo",
  "tool-goal",
  "tool-ralph",
  "tool-web",
  "tool-plugin-manager",
  "plan-mode",
];

/** The plugins `mode` keeps from `plugins`. */
export function pluginsForMode(plugins, mode) {
  return mode === "minimal" ? plugins.filter((plugin) => !TOOL_PLUGINS.has(plugin.id)) : plugins;
}

/** The rows and inserts that turn the flat standard composition into `mode`. */
export function modePatch(mode) {
  const disable = (id) => [`- id: ${id}`, "  disabled: true"];
  switch (mode) {
    case "ptc":
      // The presentation is the `tools` row's own `mode` in a flat
      // composition (the preset's `tool-presentation` row only works under a
      // preset's scope). run_code is PTC mode's composition surface; a second
      // model-authored orchestration tool beside it is what the preset turns off.
      return {
        rows: ["- id: tools", "  config:", "    mode: ptc", ...disable("tool-workflow")],
        inserts: [],
      };
    case "cordis":
      // tool-cordis waits on `cordisInspect`, which the host runner provides
      // (dsh's web app mounts it; the ACP profile does not).
      return {
        rows: [],
        inserts: [
          "    - id: cordis-host-runner",
          "      name: '@deepseek-ai/dsh-cordis-host-runner'",
          "    - id: tool-cordis",
          "      name: '@deepseek-ai/dsh-tool-cordis'",
        ],
      };
    case "minimal":
      return {
        rows: MINIMAL_DISABLED.flatMap(disable),
        inserts: [
          "    - id: persistent-shell",
          "      name: cordis:group",
          "      group: true",
          "      isolate:",
          "        terminals: true",
          "      config:",
          "        - id: pty",
          "          name: '@deepseek-ai/dsh-terminal'",
          "        - id: terminal-bash",
          "          name: '@deepseek-ai/dsh-terminal-bash'",
          "          config:",
          "            timeoutMs: 300000",
          "        - id: persistent-bash",
          "          name: '@deepseek-ai/dsh-tool-bash-persistent'",
          "          config:",
          "            timeoutMs: 300000",
        ],
      };
    default:
      return { rows: [], inserts: [] };
  }
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
  home = unieaiHome(),
  gatewayBaseUrl = null,
  visionModel = null,
  mode = "standard",
}) {
  const q = yamlQuote;
  plugins = pluginsForMode(plugins, mode);
  const execTools = plugins.some((plugin) => plugin.execTools);
  const lines = [];
  if (acp) {
    lines.push("- id: acp", "  config:", `    provider: ${DSH_PROVIDER_ID}`, `    model: ${q(defaultModel)}`);
  }
  if (persona) {
    // UNIEAI_PERSONA_RIGOR=0 drops the measured-failure rules, so a benchmark
    // arm can be scored against the same build without them.
    const text = buildPersona({
      execTools,
      shellOnly: mode === "minimal",
      rigor: process.env.UNIEAI_PERSONA_RIGOR !== "0",
    });
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
    // Above dsh's own 50 KiB default: a lower cap turned single reads into
    // windowed ones (41 reads where 57 KiB would have been one).
    "- id: tool-fs",
    "  config:",
    "    readMaxBytes: 65536",
    "- id: tool-jobs",
    "  config:",
    "    waitTimeoutMs: 60000",
    "    maxWaitTimeoutMs: 1800000",
    "- id: jobs",
    "  config:",
    "    maxConcurrentJobsPerOwner: 16",
  );
  // dsh's web_search needs a DeepSeek key uac does not have. unieai-web-search
  // replaces it (and owns this row); without that plugin, just turn it off.
  if (mode !== "minimal" && !plugins.some((plugin) => plugin.id === "unieai-web-search")) {
    lines.push("- id: tool-web", "  config:", "    fetch: true", "    search: false", "    searchTimeoutMs: 60000");
  }
  // One layout for both engines: the user's AGENTS.md (and, through
  // unieai-skills, their skills) live in the UnieAI home, not dsh's.
  lines.push("- id: agent-instructions", "  config:", "    maxBytes: 65536", `    dshHome: ${q(home)}`);
  const parts = renderPatchParts({
    plugins,
    profile: "cli",
    config: {
      "unieai-skills": { home },
      "unieai-web-search": { gatewayBaseUrl },
      "unieai-vision-fallback": visionModel ? { gatewayBaseUrl, visionModel } : {},
    },
  });
  lines.push(...parts.rows);
  const modeRows = modePatch(mode);
  lines.push(...modeRows.rows);
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
  // dsh-base (the ACP profile) leaves out the ask tool; the control plugin
  // answers it through the client, so it is only offered with one.
  if (controlSocket) {
    inserts.push("    - id: tool-ask-user", "      name: '@deepseek-ai/dsh-tool-ask-user'");
  }
  // The date, appended as a user-role snapshot so the system prefix stays put.
  inserts.push(
    "    - id: time-context",
    "      name: '@deepseek-ai/dsh-time-context'",
    "      config:",
    "        refreshIntervalMs: 1800000",
  );
  inserts.push(...parts.inserts, ...modeRows.inserts);
  lines.push("- insert:", ...inserts);
  return `${lines.join("\n")}\n`;
}

/**
 * The account model to describe images with when `defaultModel` cannot see
 * them: null when the default model takes images or no model does. Prefers a
 * model of the same family (a shared name prefix), then one named for vision.
 */
export function pickVisionModel(catalog, defaultModel) {
  const accepts = (model) => (model?.input_modalities ?? model?.inputModalities ?? []).includes("image");
  const current = catalog.find((model) => model?.id === defaultModel);
  if (current && accepts(current)) return null;
  const candidates = catalog.filter(accepts).map((model) => model.id);
  if (candidates.length === 0) return null;
  const family = String(defaultModel ?? "").split(/[-_]/).slice(0, 2).join("-").toLowerCase();
  const score = (id) => (family && id.toLowerCase().startsWith(family) ? 2 : 0) + (/vision|-vl\b|-vl-/i.test(id) ? 1 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
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
/** Local servers take no key, but dsh refuses a provider without one. */
export const LOCAL_KEY_ENV = "UNIEAI_LOCAL_API_KEY";

export function renderCredentials({ apiKey }) {
  return `version: 1\n\nrefs:\n  ${GATEWAY_KEY_ENV}: ${JSON.stringify(String(apiKey))}\n  ${LOCAL_KEY_ENV}: "local"\n`;
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
export function writeDshAccount({ env = process.env, localProviders = [] } = {}) {
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
  writeFileSync(join(home, "settings.yaml"), renderSettings({ baseUrl: credentials.gatewayBaseUrl, models: declared, defaultModel, localProviders }));
  return { home, defaultModel, models, gatewayBaseUrl: credentials.gatewayBaseUrl, visionModel: pickVisionModel(catalog, defaultModel) };
}

/**
 * Write dsh's home for the account and return the child environment and command.
 * Throws when the user is not signed in: without a gateway dsh has no model.
 */
export function prepareDsh({ env = process.env, sandboxMode = "workspace-write", controlSocket = null, mode = "standard" } = {}) {
  const { home, defaultModel, models, gatewayBaseUrl, visionModel } = writeDshAccount({ env });
  // One dsh process per mode, each with its own patch; standard keeps the
  // name it always had.
  const patchPath = join(home, mode === "standard" ? "uac.patch.yml" : `uac.${mode}.patch.yml`);
  const plugins = pluginsForMode(selectPlugins(env), mode);
  writeFileSync(patchPath, renderPatch({ defaultModel, controlSocket, plugins, gatewayBaseUrl, visionModel, mode }));

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
  return { env: childEnv, defaultModel, models, controlSocket, mode, plugins: plugins.map((p) => p.id), ...dshCommand(childEnv) };
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
