// Copyright (c) 2026 UnieAI. All rights reserved.
// The auth proxy: rabi's fixed headers, a token that changes under them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { codexTokenSource, createMcpAuthProxy } from "./unieai-mcp-auth-proxy.mjs";

/** An upstream MCP endpoint that accepts only `valid` and records what it saw. */
async function upstream(valid) {
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, auth: request.headers.authorization, session: request.headers["mcp-session-id"], extra: request.headers["x-extra"], body: Buffer.concat(chunks).toString() });
      if (request.headers.authorization !== `Bearer ${valid.current}`) {
        response.writeHead(401, { "www-authenticate": 'Bearer error="invalid_token"' }).end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: one\n\n");
        setTimeout(() => response.end("data: two\n\n"), 20);
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen, close: () => server.close() };
}

test("every request carries the token that is current, and a 401 refreshes once and retries", async () => {
  const valid = { current: "t1" };
  const up = await upstream(valid);
  let token = "t1";
  const forced = [];
  const proxy = createMcpAuthProxy({
    getToken: async (_name, _url, { force }) => {
      if (force) {
        forced.push(true);
        token = valid.current;
      }
      return token;
    },
  });
  try {
    const routed = await proxy.route({ type: "http", name: "space", url: up.url, headers: [{ name: "x-extra", value: "kept" }] });
    assert.match(routed.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/space$/);
    assert.deepEqual(routed.headers, [], "rabi gets no credentials of its own");

    const post = (headers = {}) =>
      fetch(routed.url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer from-rabi", ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' });
    let response = await post();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), "s-1");
    assert.equal(up.seen[0].auth, "Bearer t1", "the proxy's token, not whatever rabi sent");
    assert.equal(up.seen[0].extra, "kept", "configured static headers still go upstream");

    // The server rotates the token mid-session: the next call 401s once, the
    // proxy refreshes and retries the same body, and the caller sees a 200.
    valid.current = "t2";
    response = await post({ "mcp-session-id": "s-1" });
    assert.equal(response.status, 200);
    assert.deepEqual(forced, [true]);
    assert.deepEqual(up.seen.slice(1).map((r) => r.auth), ["Bearer t1", "Bearer t2"]);
    assert.equal(up.seen[2].body, up.seen[1].body, "the retry resends the request body");
    assert.equal(up.seen[2].session, "s-1");

    // A server-sent event stream is streamed through.
    const stream = await fetch(routed.url, { headers: { accept: "text/event-stream" } });
    assert.equal(await stream.text(), "data: one\n\ndata: two\n\n");

    // Nothing outside the secret path is served.
    const port = new URL(routed.url).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/guess/space`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${routed.url.replace(/space$/, "other")}`, { method: "POST" })).status, 404);
  } finally {
    proxy.close();
    up.close();
  }
});

test("the token source refreshes through codex only when the token is due, once for concurrent calls", async () => {
  let stored = { token: "old", fresh: true };
  let refreshes = 0;
  const source = codexTokenSource({
    read: (_name, _url, marginMs) => (stored.fresh || marginMs === 0 ? stored.token : null),
    refresh: async () => {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      stored = { token: "new", fresh: true };
    },
  });
  assert.equal(await source("space", "u", {}), "old");
  assert.equal(refreshes, 0, "a token with time left is used as is");

  stored = { token: null, fresh: false };
  const [a, b] = await Promise.all([source("space", "u", {}), source("space", "u", {})]);
  assert.deepEqual([a, b], ["new", "new"]);
  assert.equal(refreshes, 1, "concurrent requests share one refresh");

  await source("space", "u", { force: true });
  assert.equal(refreshes, 2, "a rejected token forces a refresh");
});
