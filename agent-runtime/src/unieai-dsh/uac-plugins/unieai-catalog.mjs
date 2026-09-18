// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-catalog.mjs — the UnieAI dsh plugins and how a host loads them.
 *
 * Each entry names a plugin module in this package, the extra patch rows it
 * needs (e.g. disabling the dsh plugin it replaces), its default config, and
 * the host profiles that load it by default:
 *   - `cli`:    UnieAI Code (uac) and the UnieAI dsh CLI. Only fixes that do
 *               not change a strong model's behaviour are on; budgets are
 *               inert unless the user sets them, and the doom guard is off.
 *   - `studio`: UnieAI Studio's server runtime: every turn is bounded and ends
 *               in text, the doom guard is on, and no shell or file tools
 *               (Studio disables dsh's).
 *
 * `renderPatch()` / `renderPatchParts()` produce cordis patch YAML (companion
 * rows and `- insert:` items with file URLs) for a dsh `--patch` file.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const PLUGINS = Object.freeze([
  {
    id: "unieai-exec",
    file: "unieai-exec.mjs",
    rows: ["- id: tool-bash", "  disabled: true"],
    execTools: true,
    profiles: ["cli"],
    summary: "codex-style exec_command / write_stdin with long-running sessions",
  },
  {
    id: "unieai-edit-observe",
    file: "unieai-edit-observe.mjs",
    rows: ["- id: fs-observation-policy", "  disabled: true"],
    profiles: ["cli"],
    summary: "read-before-edit that also counts shell reads; stale files still refused",
  },
  {
    id: "unieai-skills",
    file: "unieai-skills.mjs",
    rows: ["- id: skill-filesystem", "  disabled: true"],
    profiles: ["cli"],
    summary: "skills from <project>/.unieai/skills and ~/.unieai/skills",
  },
  { id: "unieai-edit-rescue", file: "unieai-edit-rescue.mjs", profiles: ["cli"], summary: "whitespace/indent-tolerant edit matching" },
  { id: "unieai-edit-feedback", file: "unieai-edit-feedback.mjs", profiles: ["cli"], summary: "diff and context after each edit" },
  { id: "unieai-apply-patch", file: "unieai-apply-patch.mjs", profiles: ["cli"], summary: "codex apply_patch tool" },
  {
    id: "unieai-web-search",
    file: "unieai-web-search.mjs",
    // dsh's own search needs a DeepSeek key; keep its web_fetch, drop its web_search.
    rows: ["- id: tool-web", "  config:", "    fetch: true", "    search: false", "    searchTimeoutMs: 60000"],
    profiles: ["cli"],
    // The host passes { gatewayBaseUrl }.
    summary: "web_search via the UnieAI gateway, else the user's Brave/Tavily/SerpAPI key",
  },
  {
    id: "unieai-vision-fallback",
    file: "unieai-vision-fallback.mjs",
    profiles: ["cli"],
    // The host passes { gatewayBaseUrl, visionModel } only when the default model is text-only.
    summary: "describe_image: a vision model on the same gateway describes images for a text-only model",
  },
  { id: "unieai-wait-agents", file: "unieai-wait-agents.mjs", profiles: ["cli"], summary: "wait_agents: block on background subagents instead of polling" },
  {
    id: "unieai-loop-truncation",
    file: "unieai-loop-truncation.mjs",
    config: { maxRetries: 2, growth: 2 },
    profiles: ["cli", "studio"],
    summary: "retry tool calls cut off by the output token cap",
  },
  { id: "unieai-loop-completion", file: "unieai-loop-completion.mjs", profiles: ["cli", "studio"], summary: "no turn ends on an empty or announce-only answer; completion contract" },
  { id: "unieai-loop-toolerrors", file: "unieai-loop-toolerrors.mjs", profiles: ["cli", "studio"], summary: "actionable unknown-tool / bad-argument errors" },
  { id: "unieai-toolcall-repair", file: "unieai-toolcall-repair.mjs", profiles: ["cli", "studio"], summary: "repair mis-cased or prefixed tool names" },
  { id: "unieai-context-overflow", file: "unieai-context-overflow.mjs", profiles: ["cli", "studio"], summary: "recover from context overflow and failed summaries" },
  {
    id: "unieai-loop-guard",
    file: "unieai-loop-guard.mjs",
    profiles: ["cli", "studio"],
    // Budgets come from env (UNIEAI_TURN_MAX_STEPS / UNIEAI_TURN_DEADLINE_MS) or the host.
    profileConfig: { cli: { doom: false }, studio: { doom: true } },
    rows: { studio: ["- id: repeat-tool-reminder", "  disabled: true"] },
    summary: "step/time budget with soft landing and grace step; two-layer doom guard",
  },
]);

export const PROFILES = Object.freeze(["cli", "studio"]);

/** The file URL of a plugin module in this package. */
export function pluginUrl(id) {
  const plugin = PLUGINS.find((entry) => entry.id === id);
  if (!plugin) throw new Error(`unknown UnieAI dsh plugin "${id}"`);
  return pathToFileURL(join(here, plugin.file)).href;
}

/**
 * The plugins a host loads: the profile's defaults, narrowed by
 * `UNIEAI_DSH_PLUGINS` (`all` = every plugin of the profile, `off`, or a
 * comma list of ids, which may name plugins outside the profile).
 */
export function selectPlugins({ profile = "cli", env = process.env } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`unknown profile "${profile}"`);
  const present = PLUGINS.filter((plugin) => existsSync(join(here, plugin.file)));
  const choice = String(env.UNIEAI_DSH_PLUGINS ?? "").trim();
  if (choice === "off" || choice === "none") return [];
  if (!choice || choice === "all") return present.filter((plugin) => plugin.profiles.includes(profile));
  const wanted = new Set(choice.split(",").map((id) => id.trim()).filter(Boolean));
  return present.filter((plugin) => wanted.has(plugin.id));
}

/** A plugin's config for a profile, with host overrides merged on top. */
export function pluginConfig(plugin, profile = "cli", overrides = {}) {
  return { ...(plugin.config ?? {}), ...(plugin.profileConfig?.[profile] ?? {}), ...(overrides[plugin.id] ?? {}) };
}

function pluginRows(plugin, profile) {
  if (Array.isArray(plugin.rows)) return plugin.rows;
  return plugin.rows?.[profile] ?? [];
}

const yamlValue = (value) => JSON.stringify(value);

/**
 * Patch YAML for `plugins`: `rows` (companion rows, top level) and `inserts`
 * (items for one `- insert:` row, which a host may share with its own).
 * @param {object} options
 * @param {Array} options.plugins - entries from {@link selectPlugins}.
 * @param {string} [options.profile]
 * @param {object} [options.config] - per-plugin config overrides by id.
 * @param {(plugin) => string} [options.urlOf] - where the host loads a plugin from.
 * @returns {{rows: string[], inserts: string[]}}
 */
export function renderPatchParts({ plugins, profile = "cli", config = {}, urlOf = (plugin) => pluginUrl(plugin.id) }) {
  const rows = [];
  const inserts = [];
  for (const plugin of plugins) {
    rows.push(...pluginRows(plugin, profile));
    inserts.push(`    - id: ${plugin.id}`, `      name: ${yamlValue(urlOf(plugin))}`);
    const entries = Object.entries(pluginConfig(plugin, profile, config));
    if (entries.length > 0) {
      inserts.push("      config:");
      for (const [key, value] of entries) inserts.push(`        ${key}: ${yamlValue(value)}`);
    }
  }
  return { rows, inserts };
}

/** A complete patch file body for `plugins` alone. */
export function renderPatch(options) {
  const { rows, inserts } = renderPatchParts(options);
  const lines = inserts.length > 0 ? [...rows, "- insert:", ...inserts] : rows;
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
