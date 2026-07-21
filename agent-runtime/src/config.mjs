/**
 * config.mjs — resolve UnieAI credentials, models, and the sandbox binary.
 *
 * Reads the same unieai.json that `unieai login` writes, so the agent-core
 * runtime shares sign-in state with the Rust CLI/TUI.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function unieaiHome() {
  return process.env.UNIEAI_HOME || process.env.CODEX_HOME || join(homedir(), ".unieai");
}

export function loadCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(join(unieaiHome(), "unieai.json"), "utf8"));
    const models = parsed.available_models
      ? parsed.available_models
      : (parsed.available_model_ids || []).map((id) => ({ id }));
    return {
      signedIn: true,
      gatewayBaseUrl: parsed.gateway_base_url,
      gatewayApiKey: parsed.gateway_api_key,
      studioUrl: parsed.studio_url,
      models
    };
  } catch {
    return { signedIn: false, gatewayBaseUrl: "", gatewayApiKey: "", studioUrl: "", models: [] };
  }
}

/** Configure agent-core's upstream env for this process. */
export function applyUpstreamEnv(credentials) {
  if (credentials.gatewayBaseUrl) process.env.AGENT_CORE_UPSTREAM_BASE_URL = credentials.gatewayBaseUrl;
  process.env.AGENT_CORE_WIRE_API = process.env.AGENT_CORE_WIRE_API || "responses";
  // UnieAI Code opts into the tighter 429 cap here (agent-core's shared default
  // stays neutral so Studio/KDA are unaffected). This only touches THIS process.
  if (process.env.AGENT_1_0_RETRY_MAX_429 == null) process.env.AGENT_1_0_RETRY_MAX_429 = "2";
}

/** The Rust binary that provides `unieai sandbox` (and login). */
export function sandboxBin() {
  return process.env.UNIEAI_BIN || "unieai";
}
