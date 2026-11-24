// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai_render_dsh.mjs — render the dsh-unieai arm's settings.yaml and patch
 * with the plugin pack's own config.mjs, so the benchmark runs exactly what
 * uac would write.
 *
 *   node unieai_render_dsh.mjs <pack>/config.mjs <model> <gateway-base-url> [<model-json>]
 *
 * Prints {settings, patch, plugins, renderer} as JSON. Plugin rows carry host
 * file URLs; unieai_agents.py rewrites them to the container path. The ACP
 * route row is left out: the headless profile reads agent-default-model.
 * UNIEAI_DSH_PLUGINS selects plugins as it does for uac.
 */
import { pathToFileURL } from "node:url";

const [configPath, model, baseUrl, metadataJson] = process.argv.slice(2);
if (!configPath || !model || !baseUrl) {
  console.error("usage: unieai_render_dsh.mjs <config.mjs> <model> <gateway-base-url>");
  process.exit(2);
}

const pack = await import(pathToFileURL(configPath).href);
const modern = typeof pack.selectPlugins === "function" && typeof pack.gatewayModel === "function";

let settings = null;
let patch = "";
let plugins = [];
if (modern) {
  const selected = pack.selectPlugins(process.env);
  plugins = selected.map((plugin) => plugin.id);
  // The account's own facts about the model (context window, modalities), so
  // every arm runs on the same metadata.
  const declared = metadataJson ? JSON.parse(metadataJson) : { id: model };
  settings = pack.renderSettings({ baseUrl, models: [declared], defaultModel: model });
  patch = pack.renderPatch({ defaultModel: model, plugins: selected, acp: false });
} else if (typeof pack.renderSettings === "function") {
  // Pre-plugin pack: the provider declaration only; nothing to patch.
  settings = pack.renderSettings({ baseUrl, models: [model], defaultModel: model });
}

process.stdout.write(
  `${JSON.stringify({ settings, patch, plugins, renderer: modern ? "plugins" : "legacy" })}\n`,
);
