// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-mcp-servers.mjs — MCP servers for uac's dsh sessions.
 *
 * codex reads `[mcp_servers]` from config.toml; uac opened dsh sessions with
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
import { existsSync } from "node:fs";
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
 * Entries dsh cannot take are skipped with the reason.
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
 * Which server a failed `session/new` blames: dsh names a server whose first
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
