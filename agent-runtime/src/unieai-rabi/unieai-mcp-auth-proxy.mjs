// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-mcp-auth-proxy.mjs — keeps an OAuth MCP server signed in for the
 * whole of a rabi session.
 *
 * rabi's MCP client sends the headers it was opened with on every request, so
 * a bearer token handed over when the session opened expires with the token
 * (Space: one hour) and every tool call after that is a 401. Claude Code
 * refreshes in flight instead. This does the same from outside rabi: rabi
 * talks to a loopback URL, and each request is forwarded to the real server
 * with the token that is current at that moment.
 *
 * The token itself still comes from codex: `getToken` reads its store and,
 * when the token is due, has the Rust side refresh it (under codex's
 * cross-process lock) instead of spending a refresh token here.
 *
 * Only loopback, and only paths under a random secret: another local user or
 * a web page cannot borrow the session's credentials through it.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";

/** Request headers that describe the hop to us, not the request upstream. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
  "accept-encoding",
]);

/** Response headers that fetch has already acted on (it decompresses). */
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    request.on("error", reject);
  });

/**
 * @param {object} options
 * @param {(name: string, url: string, { force: boolean }) => Promise<string|null>} options.getToken
 *   The current access token; `force` after the server rejected the last one.
 * @param {(...args: unknown[]) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createMcpAuthProxy({ getToken, log = () => {}, fetchImpl = fetch }) {
  const secret = randomBytes(18).toString("base64url");
  /** name -> { url, headers: [{name, value}] } */
  const routes = new Map();
  let server = null;
  let listening = null;

  const forward = async (route, name, request, body, token) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (HOP_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    for (const header of route.headers) headers.set(header.name, header.value);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(route.url, { method: request.method, headers, body: body ?? undefined, redirect: "manual" });
  };

  const handle = async (request, response) => {
    const path = new URL(request.url ?? "/", "http://loopback").pathname;
    const [, key, encoded] = path.split("/");
    const name = encoded === undefined ? undefined : decodeURIComponent(encoded);
    const route = key === secret && name !== undefined ? routes.get(name) : undefined;
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    const body = await readBody(request);
    let upstream = await forward(route, name, request, body, await getToken(name, route.url, { force: false }));
    if (upstream.status === 401) {
      // The token was revoked or expired early: refresh once and retry. The
      // body was buffered, so the retry sends the same request.
      await upstream.body?.cancel().catch(() => {});
      const fresh = await getToken(name, route.url, { force: true });
      if (fresh) upstream = await forward(route, name, request, body, fresh);
      if (upstream.status === 401) log(`[uac] MCP server ${name} rejected its token; run \`/mcp login ${name}\``);
    }
    const headers = {};
    upstream.headers.forEach((value, header) => {
      if (!DROP_RESPONSE_HEADERS.has(header)) headers[header] = value;
    });
    response.writeHead(upstream.status, headers);
    if (!upstream.body) {
      response.end();
      return;
    }
    // Streamed through, so a server-sent event stream stays a stream.
    const stream = Readable.fromWeb(upstream.body);
    request.on("close", () => stream.destroy());
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const start = () => {
    listening ??= new Promise((resolve, reject) => {
      server = createServer((request, response) => {
        handle(request, response).catch((error) => {
          log(`[uac] MCP auth proxy: ${error?.message ?? error}`);
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        resolve(server.address().port);
      });
    });
    return listening;
  };

  return {
    /** The ACP server entry rabi should open instead of `server`. */
    async route(server) {
      const port = await start();
      routes.set(server.name, { url: server.url, headers: server.headers ?? [] });
      return { ...server, url: `http://127.0.0.1:${port}/${secret}/${encodeURIComponent(server.name)}`, headers: [] };
    },
    close() {
      server?.close();
      server = null;
      listening = null;
    },
  };
}

/**
 * getToken for the proxy: the stored token while it has five minutes left;
 * otherwise ask the Rust side to refresh (`refresh(name)`) and read again.
 * Concurrent requests for one server share one refresh.
 */
export function codexTokenSource({ read, refresh, refreshMarginMs = 5 * 60_000 }) {
  const inFlight = new Map();
  return async (name, url, { force = false } = {}) => {
    if (!force) {
      const token = read(name, url, refreshMarginMs);
      if (token) return token;
    }
    if (!inFlight.has(name)) {
      inFlight.set(
        name,
        Promise.resolve()
          .then(() => refresh(name, { force }))
          .catch(() => {})
          .finally(() => inFlight.delete(name)),
      );
    }
    await inFlight.get(name);
    // After a refresh anything not yet expired will do.
    return read(name, url, 0);
  };
}
