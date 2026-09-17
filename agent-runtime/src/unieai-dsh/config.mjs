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

/** dsh's `settings.yaml` for the gateway. YAML is written by hand: flat and quoted. */
export function renderSettings({ baseUrl, models, defaultModel }) {
  const q = (value) => JSON.stringify(String(value));
  const lines = [
    "# Written by unieai-agent-core (uac) on every start; edits are overwritten.",
    "llm-pi-ai:",
    "  providers:",
    `    ${DSH_PROVIDER_ID}:`,
    `      displayName: ${q("UnieAI")}`,
    `      apiKeyEnv: ${GATEWAY_KEY_ENV}`,
    "      api: openai-completions",
    `      baseURL: ${q(baseUrl)}`,
    "      compat:",
    "        supportsDeveloperRole: false",
    "        maxTokensField: max_tokens",
    "      models:",
    ...models.map((id) => `        - id: ${q(id)}`),
  ];
  if (defaultModel) {
    lines.push("agent-default-model:", `  provider: ${DSH_PROVIDER_ID}`, `  model: ${q(defaultModel)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The ACP profile's own route (it ignores `agent-default-model`), plus the
 * unieai-control plugin that serves what ACP does not.
 */
export function renderPatch({ defaultModel, controlSocket = null, pluginUrl = CONTROL_PLUGIN_URL }) {
  const q = (value) => JSON.stringify(String(value));
  const lines = [
    "- id: acp",
    "  config:",
    `    provider: ${DSH_PROVIDER_ID}`,
    `    model: ${q(defaultModel)}`,
  ];
  if (controlSocket) {
    lines.push(
      "- insert:",
      "    - id: unieai-control",
      `      name: ${q(pluginUrl)}`,
      "      config:",
      `        socket: ${q(controlSocket)}`,
      `        provider: ${DSH_PROVIDER_ID}`,
      `        model: ${q(defaultModel)}`,
    );
  }
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
  const listed = credentials.models.map((m) => m?.id).filter(Boolean);
  const defaultModel = pickDefaultModel({ explicit: env.UNIEAI_MODEL, configured: configuredModel(), listed });
  if (!defaultModel) {
    throw new Error("no models are available for this UnieAI account; add models in UnieAI Studio");
  }
  const models = [...new Set([defaultModel, ...listed])];
  writePrivate(join(home, ".credentials.yaml"), renderCredentials({ apiKey: credentials.gatewayApiKey || "" }));
  writeFileSync(join(home, "settings.yaml"), renderSettings({ baseUrl: credentials.gatewayBaseUrl, models, defaultModel }));
  return { home, defaultModel, models };
}

/**
 * Write dsh's home for the account and return the child environment and command.
 * Throws when the user is not signed in: without a gateway dsh has no model.
 */
export function prepareDsh({ env = process.env, sandboxMode = "workspace-write", controlSocket = null } = {}) {
  const { home, defaultModel, models } = writeDshAccount({ env });
  const patchPath = join(home, "uac.patch.yml");
  writeFileSync(patchPath, renderPatch({ defaultModel, controlSocket }));

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
  return { env: childEnv, defaultModel, models, controlSocket, ...dshCommand(childEnv) };
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
