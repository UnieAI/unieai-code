// Copyright (c) 2026 UnieAI. All rights reserved.
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

/** Where Rabi is (codex-rs/login/src/unieai_rabi.rs DEFAULT_RABI_URL). */
export const RABI_URL = "https://rabi.unieai.com";
/**
 * Where Rabi was until 2026-11. It now redirects to RABI_URL, and fetch drops
 * the Authorization header on a redirect to another host, so a login stored
 * with this origin would get 401 for every request.
 */
export const LEGACY_RABI_URL = "https://agent.unieai.com";

/** `url` with Rabi's former origin replaced by its current one; any other URL unchanged. */
export function canonicalRabiUrl(url) {
  const text = String(url ?? "");
  if (!text.startsWith(LEGACY_RABI_URL)) return url;
  const rest = text.slice(LEGACY_RABI_URL.length);
  return rest === "" || rest.startsWith("/") ? RABI_URL + rest : url;
}

export function loadCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(join(unieaiHome(), "unieai.json"), "utf8"));
    const models = parsed.available_models
      ? parsed.available_models
      : (parsed.available_model_ids || []).map((id) => ({ id }));
    return {
      signedIn: true,
      // A Rabi login from before the product moved hosts keeps working.
      gatewayBaseUrl: canonicalRabiUrl(parsed.gateway_base_url),
      gatewayApiKey: parsed.gateway_api_key,
      studioUrl: canonicalRabiUrl(parsed.studio_url),
      // Which account this is, for a client to notice it changed (see
      // accountId): never the key itself.
      accountId: accountId(parsed),
      models
    };
  } catch {
    return { signedIn: false, gatewayBaseUrl: "", gatewayApiKey: "", studioUrl: "", accountId: "", models: [] };
  }
}

/**
 * Who a credentials file signs in as: the product, the gateway it uses and
 * the user. A long-running server started for one account serves models and
 * threads that belong to it, so a client on another account must replace it.
 */
export function accountId(parsed) {
  if (!parsed) return "";
  return [parsed.account ?? "studio", parsed.gateway_base_url ?? "", parsed.email ?? ""].join("|");
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
