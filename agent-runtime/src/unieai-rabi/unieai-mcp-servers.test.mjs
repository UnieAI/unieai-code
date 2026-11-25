// Copyright (c) 2026 UnieAI. All rights reserved.
// MCP servers for uac: codex's `[mcp_servers]` as ACP servers, plus Studio's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acpMcpServers, attachOAuthTokens, blamedServer, sessionMcpServers, storedOAuthAccessToken, studioMcpServer, STUDIO_SERVER_NAME } from "./unieai-mcp-servers.mjs";

const env = { PATH: "/opt/bin:/usr/bin", DOCS_TOKEN: "t0ken", TRACE_ID: "abc" };
const exists = (path) => path === "/usr/bin/node";

test("codex's server entries become the ACP servers rabi opens", () => {
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

test("an OAuth server reaches rabi with codex's current token, or not at all when signed out", async () => {
  const configured = {
    space: { url: "https://space.example/mcp" },
    signedout: { url: "https://other.example/mcp" },
    keyed: { url: "https://keyed.example/mcp", bearer_token_env_var: "DOCS_TOKEN" },
    open: { url: "https://open.example/mcp" },
  };
  const { servers: converted } = acpMcpServers(configured, { env, exists });
  const probed = [];
  const status = { space: "oAuth", signedout: "notLoggedIn", open: "unsupported" };
  const { servers, notes } = await attachOAuthTokens(converted, {
    configured,
    probe: async (name) => {
      probed.push(name);
      return { name, authStatus: status[name] };
    },
    readToken: (name) => (name === "space" ? "uwa_current" : null),
  });
  // A server with its own bearer token is not asked about.
  assert.deepEqual(probed, ["space", "signedout", "open"]);
  const byName = Object.fromEntries(servers.map((server) => [server.name, server]));
  assert.deepEqual(byName.space.headers, [{ name: "Authorization", value: "Bearer uwa_current" }]);
  assert.equal(byName.signedout, undefined, "a signed-out server is left out rather than failing to connect");
  assert.match(notes.join("\n"), /signedout: not signed in; run `\/mcp login signedout`/);
  assert.deepEqual(byName.open.headers, [], "a server without auth is passed through");
  assert.deepEqual(byName.keyed.headers, [{ name: "Authorization", value: "Bearer t0ken" }]);

  // The probe failing must not drop the server.
  const failing = await attachOAuthTokens(converted, {
    configured,
    probe: async () => {
      throw new Error("app-server is not running");
    },
    readToken: () => null,
  });
  assert.equal(failing.servers.length, converted.length);
});

test("only a current token is read from codex's file store, matched by name and url", () => {
  const now = 1_000_000;
  const store = {
    "space|aaaa": { server_name: "space", server_url: "https://space.example/mcp", access_token: "good", expires_at: now + 10 * 60_000 },
    "space|bbbb": { server_name: "space", server_url: "https://elsewhere.example/mcp", access_token: "wrong-url" },
    "old|cccc": { server_name: "old", server_url: "https://old.example/mcp", access_token: "stale", expires_at: now + 30_000 },
  };
  const read = () => JSON.stringify(store);
  assert.equal(storedOAuthAccessToken({ home: "/h", name: "space", url: "https://space.example/mcp/", now, read }), "good");
  assert.equal(storedOAuthAccessToken({ home: "/h", name: "old", url: "https://old.example/mcp", now, read }), null, "expiring within the margin");
  assert.equal(storedOAuthAccessToken({ home: "/h", name: "none", url: "x", now, read }), null);
  assert.equal(storedOAuthAccessToken({ home: "/h", name: "space", url: "https://space.example/mcp", now, read: () => { throw new Error("ENOENT"); } }), null);
});
