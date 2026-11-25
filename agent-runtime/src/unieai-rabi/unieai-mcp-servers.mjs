// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-mcp-servers.mjs — MCP servers for uac's rabi sessions.
 *
 * codex reads `[mcp_servers]` from config.toml; uac opened rabi sessions with
 * none, so a server the user configured (and /mcp listed) never reached the
 * model. This turns codex's server entries into ACP `mcpServers`, and adds
 * UnieAI Studio's own MCP server for the signed-in account: its knowledge
 * bases, SQL connections and skills (`/v1/mcp` on the gateway, authorized by
 * the account's key, so the model sees exactly what the user may see).
 *
 * Studio's server is on by default; `UNIEAI_STUDIO_MCP=0` turns it off, and
 * a configured server named `unieai_studio` replaces it (for instance one
 * scoped to a single knowledge base: `<gateway>/mcp/kb/<id>`).
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const STUDIO_SERVER_NAME = "unieai_studio";

/** `command` as an absolute path (ACP requires one), or null when not found. */
export function resolveCommand(command, env = process.env, exists = existsSync) {
  if (!command) return null;
  if (isAbsolute(command)) return exists(command) ? command : null;
  if (command.includes("/")) return null;
  for (const dir of String(env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

const entries = (record) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value: String(value) }));

/**
 * codex's `mcp_servers` (as config/read returns them) -> ACP servers.
 * Entries rabi cannot take are skipped with the reason.
 * @returns {{ servers: object[], skipped: string[] }}
 */
export function acpMcpServers(config, { env = process.env, exists = existsSync } = {}) {
  const servers = [];
  const skipped = [];
  for (const [name, server] of Object.entries(config ?? {})) {
    if (!server || server.enabled === false) continue;
    if (server.url) {
      const headers = { ...server.http_headers };
      for (const [header, variable] of Object.entries(server.env_http_headers ?? {})) {
        if (env[variable]) headers[header] = env[variable];
      }
      if (server.bearer_token_env_var) {
        const token = env[server.bearer_token_env_var];
        if (!token) {
          skipped.push(`${name}: ${server.bearer_token_env_var} is not set`);
          continue;
        }
        headers.Authorization = `Bearer ${token}`;
      }
      servers.push({ type: "http", name, url: server.url, headers: entries(headers) });
    } else if (server.command) {
      const command = resolveCommand(server.command, env, exists);
      if (!command) {
        skipped.push(`${name}: ${server.command} not found`);
        continue;
      }
      servers.push({ name, command, args: (server.args ?? []).map(String), env: entries(server.env) });
    } else {
      skipped.push(`${name}: neither url nor command`);
    }
  }
  return { servers, skipped };
}

/** Studio's MCP server for this account, or null (signed out, or turned off). */
export function studioMcpServer({ gatewayBaseUrl, gatewayApiKey, env = process.env }) {
  if (env.UNIEAI_STUDIO_MCP === "0" || !gatewayBaseUrl || !gatewayApiKey) return null;
  return {
    type: "http",
    name: STUDIO_SERVER_NAME,
    url: `${String(gatewayBaseUrl).replace(/\/+$/, "")}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${gatewayApiKey}` }],
  };
}

/** The configured servers, with Studio's unless one of that name is configured. */
export function sessionMcpServers({ configured = [], studio = null }) {
  if (!studio || configured.some((server) => server.name === STUDIO_SERVER_NAME)) return configured;
  return [studio, ...configured];
}

/**
 * Which server a failed `session/new` blames: rabi names a server whose first
 * connection failed (`mcp-client(<name>)`), or an entry it rejected
 * (`mcpServers[<index>]`). Null when the error is not about a server.
 */
export function blamedServer(error, servers) {
  const text = `${error?.message ?? ""} ${JSON.stringify(error?.data ?? "")}`;
  const byIndex = text.match(/mcpServers\[(\d+)\]/);
  if (byIndex) return servers[Number(byIndex[1])] ?? null;
  const byName = text.match(/mcp-client\(([^)]+)\)/);
  if (byName) {
    const normalized = byName[1];
    return servers.find((server) => server.name === normalized || normalized.startsWith(server.name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 20))) ?? null;
  }
  return null;
}

/**
 * OAuth servers (`unieai mcp login <name>`). codex keeps their tokens in its
 * own store and refreshes them itself; rabi only takes static headers, so a
 * server like `space` used to reach rabi with no Authorization at all, fail
 * its first connection, and leave the model without its tools — which is how
 * the model ended up probing resources and hand-writing OAuth instead.
 *
 * Before a session opens, the Rust side is asked about each such server
 * (`mcpServerStatus/list`, one server). That connects with codex's OAuth
 * runtime, which refreshes an expiring token under its cross-process lock and
 * writes it back, so the token read afterwards is current and no refresh token
 * is ever spent from JS (Space revokes a whole grant when one is replayed).
 */

/** The configured entries whose auth is codex's OAuth, by server name. */
function oauthCandidate(name, configured, server) {
  if (server?.type !== "http") return false;
  if (server.headers?.some((header) => header.name.toLowerCase() === "authorization")) return false;
  const entry = configured?.[name];
  if (!entry?.url || entry.bearer_token_env_var) return false;
  return true;
}

const normalizedAuth = (status) => String(status ?? "").replace(/_/g, "").toLowerCase();

/**
 * The stored access token for `name` at `url`, when it is still good for at
 * least `marginMs`. Only codex's file store can be read here (the keyring is
 * not reachable from Node); null otherwise.
 */
export function storedOAuthAccessToken({ home, name, url, now = Date.now(), marginMs = 60_000, read = readFileSync }) {
  let store;
  try {
    store = JSON.parse(read(join(home, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
  const trim = (value) => String(value ?? "").replace(/\/+$/, "");
  for (const entry of Object.values(store ?? {})) {
    if (entry?.server_name !== name || trim(entry?.server_url) !== trim(url)) continue;
    if (!entry.access_token) return null;
    if (typeof entry.expires_at === "number" && entry.expires_at - marginMs <= now) return null;
    return entry.access_token;
  }
  return null;
}

/**
 * Gives each OAuth server its current bearer token (or, with `route`, sends it
 * through the auth proxy, which keeps the token current), and leaves out one that
 * is not signed in (rabi would only fail to connect it) with a log line that
 * says how to sign in. `probe(name)` resolves to the server's McpServerStatus.
 * @returns {Promise<{ servers: object[], notes: string[] }>}
 */
export async function attachOAuthTokens(servers, { configured, probe, readToken, route = null }) {
  const out = [];
  const notes = [];
  for (const server of servers) {
    if (!oauthCandidate(server.name, configured, server)) {
      out.push(server);
      continue;
    }
    let status = null;
    try {
      status = await probe(server.name);
    } catch (error) {
      notes.push(`${server.name}: could not read its sign-in state (${error?.message ?? error}); connecting without a token`);
      out.push(server);
      continue;
    }
    const auth = normalizedAuth(status?.authStatus);
    if (auth === "notloggedin") {
      notes.push(`${server.name}: not signed in; run \`/mcp login ${server.name}\` (or \`unieai mcp login ${server.name}\`)`);
      continue;
    }
    if (auth !== "oauth") {
      out.push(server);
      continue;
    }
    if (route) {
      // Through the auth proxy, which puts the current token on every request.
      out.push(await route(server));
      continue;
    }
    const token = readToken(server.name, server.url);
    if (!token) {
      notes.push(`${server.name}: signed in, but no current token could be read (keyring store, or the refresh failed); run \`/mcp login ${server.name}\` if its tools are missing`);
      out.push(server);
      continue;
    }
    out.push({ ...server, headers: [...(server.headers ?? []), { name: "Authorization", value: `Bearer ${token}` }] });
  }
  return { servers: out, notes };
}
