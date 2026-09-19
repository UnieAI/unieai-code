// Copyright (c) 2026 UnieAI. All rights reserved.
// MCP servers for uac: codex's `[mcp_servers]` as ACP servers, plus Studio's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acpMcpServers, blamedServer, sessionMcpServers, studioMcpServer, STUDIO_SERVER_NAME } from "./unieai-mcp-servers.mjs";

const env = { PATH: "/opt/bin:/usr/bin", DOCS_TOKEN: "t0ken", TRACE_ID: "abc" };
const exists = (path) => path === "/usr/bin/node";

test("codex's server entries become the ACP servers dsh opens", () => {
  const result = acpMcpServers(
    {
      docs: { url: "https://docs.example/mcp", bearer_token_env_var: "DOCS_TOKEN", http_headers: { "X-Team": "a" }, env_http_headers: { "X-Trace": "TRACE_ID" } },
      local: { command: "node", args: ["server.js", 3], env: { MODE: "ro" } },
      off: { command: "node", enabled: false },
      nokey: { url: "https://x.example/mcp", bearer_token_env_var: "MISSING" },
      gone: { command: "not-installed" },
    },
    { env, exists },
  );
  assert.deepEqual(result, {
    servers: [
      {
        type: "http",
        name: "docs",
        url: "https://docs.example/mcp",
        headers: [
          { name: "X-Team", value: "a" },
          { name: "X-Trace", value: "abc" },
          { name: "Authorization", value: "Bearer t0ken" },
        ],
      },
      { name: "local", command: "/usr/bin/node", args: ["server.js", "3"], env: [{ name: "MODE", value: "ro" }] },
    ],
    skipped: ["nokey: MISSING is not set", "gone: not-installed not found"],
  });
});

test("Studio's server comes with the sign-in, unless turned off or configured", () => {
  const account = { gatewayBaseUrl: "https://api.unieai.com/v1/", gatewayApiKey: "k" };
  const studio = studioMcpServer({ ...account, env: {} });
  assert.deepEqual(studio, {
    type: "http",
    name: STUDIO_SERVER_NAME,
    url: "https://api.unieai.com/v1/mcp",
    headers: [{ name: "Authorization", value: "Bearer k" }],
  });
  assert.equal(studioMcpServer({ ...account, env: { UNIEAI_STUDIO_MCP: "0" } }), null);
  assert.equal(studioMcpServer({ gatewayBaseUrl: "", gatewayApiKey: "", env: {} }), null);

  const other = { name: "docs", command: "/usr/bin/node", args: [], env: [] };
  assert.deepEqual(sessionMcpServers({ configured: [other], studio }), [studio, other]);
  const scoped = { ...studio, url: "https://api.unieai.com/v1/mcp/kb/kb-1" };
  assert.deepEqual(sessionMcpServers({ configured: [scoped], studio }), [scoped]);
});

test("the server a refused session blames, by index or by name", () => {
  const servers = [{ name: "unieai_studio" }, { name: "docs" }];
  assert.equal(blamedServer(new Error("mcpServers[1] is invalid: bad url"), servers), servers[1]);
  assert.equal(blamedServer({ message: "Internal error", data: "mcp-client(unieai_studio): initial connection or tool synchronization failed" }, servers), servers[0]);
  assert.equal(blamedServer(new Error("no adapter registered"), servers), null);
});
