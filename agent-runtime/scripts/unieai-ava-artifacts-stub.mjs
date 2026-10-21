#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-ava-artifacts-stub.mjs — an in-memory stand-in for ava's artifact
 * routes (docs/unieai/artifacts-spec.md, ava commit 26d9e43e2), until they
 * are deployed.
 *
 *   node scripts/unieai-ava-artifacts-stub.mjs [--port 0] [--key rk-test] [--orgs org_a,org_b]
 *
 * prints `listening <url>` and serves, with ava's shapes, status codes,
 * limits, CDN allow-list and bearer-key auth:
 *   POST   /api/agent-next/artifacts/site           201 {id, viewerUrl, version}
 *   PUT    /api/agent-next/artifacts/:id            409 version_conflict / not_uploadable
 *   PATCH  /api/agent-next/artifacts/:id            visibility and header only
 *   GET    /api/agent-next/artifacts?mine=1&source=unieai-code   {mine, org, usage, limits}
 *   GET    /api/agent-next/artifacts/:id            metadata + files
 *   DELETE /api/agent-next/artifacts/:id[?expectedVersion=n]     204, tombstone
 *   GET    /share/html/:token                       the entry page
 * Test hooks: POST /__stub/bump/:id (an edit in ava's web UI), POST
 * /__stub/chat (a page published from an ava chat). `scopelessKey` is a key
 * without the `artifacts` scope (403).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = "/api/agent-next/artifacts";
const MiB = 1024 * 1024;
const LIMITS = { file: 4 * MiB, deps: 12 * MiB, depCount: 48, share: 16 * MiB, body: 23 * MiB, activeShares: 100, userBytes: 256 * MiB };
const ALLOWED = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const MIME = { html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml", png: "image/png", txt: "text/plain" };
const mimeOf = (path) => MIME[path.split(".").pop().toLowerCase()] ?? "application/octet-stream";

const send = (res, status, body) => {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function preflight(body) {
  if (typeof body?.title !== "string" || !body.title.trim()) return [422, "preflight_failed", "title is required"];
  const entry = body.entry ?? "index.html";
  if (!Array.isArray(body.files) || !body.files.some((file) => file.path === entry)) return [422, "preflight_failed", "entry is not among files"];
  let deps = 0;
  let total = 0;
  for (const file of body.files) {
    const size = Buffer.from(String(file.contentBase64 ?? ""), "base64").length;
    if (size > LIMITS.file) return [413, "too_large", `${file.path} is over 4 MiB`, { path: file.path }];
    total += size;
    if (file.path !== entry) deps += size;
    if (/\.(html?|css|m?js)$/i.test(file.path)) {
      const text = Buffer.from(file.contentBase64, "base64").toString("utf8");
      for (const ref of text.matchAll(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']|url\(\s*["']?((?:https?:)?\/\/[^"')]+)/gi)) {
        const url = ref[1] ?? ref[2];
        if (/<a\s[^>]*$/i.test(text.slice(0, ref.index))) continue;
        const host = url.replace(/^(https?:)?\/\//i, "").split(/[/?#:]/)[0].toLowerCase();
        if (ALLOWED.includes(host) && !/^http:/i.test(url)) continue;
        return [422, "external_ref", `external reference in ${file.path}`, { path: file.path, reference: url, issues: [`${file.path}: ${url} is not on the allow-list`] }];
      }
    }
  }
  if (body.files.length - 1 > LIMITS.depCount) return [413, "too_large", "more than 48 dependencies"];
  if (deps > LIMITS.deps || total > LIMITS.share) return [413, "too_large", "share over the size limit"];
  return null;
}

/** Start the stub. @returns {Promise<{url, store, requests, bump, chatPage, close}>} */
export async function startStub({ apiKey = "rk-test", scopelessKey = "rk-noscope", orgs = ["org_a"], port = 0, host = "127.0.0.1" } = {}) {
  const store = new Map();
  const requests = [];
  let next = 1;
  const view = (row) => ({ id: row.id, viewerUrl: `/share/html/${row.token}`, version: row.version });
  const listItem = (row) => ({ id: row.id, title: row.title, url: `/share/html/${row.token}`, viewerUrl: `/share/html/${row.token}`, version: row.version, updatedAt: row.updatedAt, source: row.source });
  const active = () => [...store.values()].filter((row) => !row.deleted);
  const normalizeFiles = (files) =>
    files.map((file) => {
      const bytes = Buffer.from(String(file.contentBase64 ?? ""), "base64");
      // The client's mime is ignored: the extension decides.
      return { path: file.path, mime: mimeOf(file.path), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: file.contentBase64 };
    });
  /** [status, code, message] when the visibility/org combination is refused, else {visibility, orgId}. */
  const resolveVisibility = (body, current) => {
    const visibility = body.visibility ?? current?.visibility ?? "private";
    if (!["private", "org"].includes(visibility)) return [400, "preflight_failed", "visibility must be private or org (public is set in the web UI)"];
    if (visibility !== "org") return { visibility, orgId: null };
    if (body.orgId) return orgs.includes(body.orgId) ? { visibility, orgId: body.orgId } : [403, "org_forbidden", "not a member of that organization"];
    if (current?.orgId && body.visibility === undefined) return { visibility, orgId: current.orgId };
    if (orgs.length === 1) return { visibility, orgId: orgs[0] };
    return [403, "org_required", "the user belongs to several organizations; pass orgId", { orgs }];
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://stub");
    if (raw.length > LIMITS.body) return fail(res, 413, "too_large", "request body over 23 MiB");
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      return fail(res, 400, "preflight_failed", "body is not JSON");
    }
    requests.push({ method: req.method, path: url.pathname, query: url.search, authorized: req.headers.authorization === `Bearer ${apiKey}`, body });

    const share = url.pathname.match(/^\/share\/html\/([\w-]+)$/);
    if (req.method === "GET" && share) {
      const row = active().find((r) => r.token === share[1]);
      if (!row) return fail(res, 404, "not_found", "no such share");
      const entry = row.files.find((f) => f.path === row.entry);
      res.writeHead(200, { "content-type": "text/html" }).end(Buffer.from(entry.contentBase64, "base64"));
      return;
    }
    const bump = url.pathname.match(/^\/__stub\/bump\/([\w-]+)$/);
    if (req.method === "POST" && bump) {
      const row = store.get(bump[1]);
      if (!row) return fail(res, 404, "not_found", "no such artifact");
      row.version += 1;
      row.files = normalizeFiles([
        ...row.files.filter((f) => f.path !== "notes.txt"),
        { path: "notes.txt", contentBase64: Buffer.from(`edited in the web UI (v${row.version})`).toString("base64") },
      ]);
      return send(res, 200, view(row));
    }
    if (req.method === "POST" && url.pathname === "/__stub/chat") {
      const id = `art_${next++}`;
      const row = { id, token: randomBytes(9).toString("base64url"), kind: "site", source: "agent-next", origin: "chat", title: "From a chat", description: null, entry: "index.html", files: normalizeFiles([{ path: "index.html", contentBase64: Buffer.from("<p>chat</p>").toString("base64") }]), visibility: "private", orgId: null, header: null, version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      store.set(id, row);
      return send(res, 201, view(row));
    }
    if (!url.pathname.startsWith(ROUTE)) return fail(res, 404, "not_found", "no such route");
    if (req.headers.authorization === `Bearer ${scopelessKey}`) return fail(res, 403, "forbidden", "this key lacks the artifacts scope");
    if (req.headers.authorization !== `Bearer ${apiKey}`) return fail(res, 401, "unauthorized", "missing or invalid desktop key");
    const rest = url.pathname.slice(ROUTE.length);

    if (req.method === "POST" && rest === "/site") {
      const problem = preflight(body);
      if (problem) return fail(res, problem[0], problem[1], problem[2], problem[3]);
      const vis = resolveVisibility(body ?? {}, null);
      if (Array.isArray(vis)) return fail(res, vis[0], vis[1], vis[2], vis[3]);
      if (active().length >= LIMITS.activeShares) return fail(res, 429, "quota_exceeded", "100 active shares");
      const id = `art_${next++}`;
      const now = new Date().toISOString();
      const row = {
        id,
        token: randomBytes(9).toString("base64url"),
        kind: "site",
        source: "unieai-code",
        origin: "upload",
        title: body.title,
        description: body.description ?? null,
        entry: body.entry ?? "index.html",
        files: normalizeFiles(body.files),
        ...vis,
        header: body.header ? { showAuthor: false, ...body.header } : null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      store.set(id, row);
      return send(res, 201, view(row));
    }
    if (req.method === "GET" && rest === "") {
      if (url.searchParams.get("mine") !== "1") return fail(res, 400, "preflight_failed", "mine=1 is required");
      const source = url.searchParams.get("source");
      const rows = active().filter((r) => !source || r.source === source);
      const bytes = active().reduce((sum, r) => sum + r.files.reduce((s, f) => s + f.size, 0), 0);
      return send(res, 200, {
        mine: rows.map(listItem),
        org: [],
        usage: { activeShares: active().length, bytes },
        limits: { activeShares: LIMITS.activeShares, bytes: LIMITS.userBytes },
      });
    }
    const one = rest.match(/^\/([\w-]+)$/);
    if (!one) return fail(res, 404, "not_found", "no such route");
    const row = store.get(one[1]);
    if (!row || row.deleted) return fail(res, 404, "not_found", "no such artifact");
    if (req.method === "GET") {
      const { token, deleted, orgId, ...meta } = row;
      return send(res, 200, { ...meta, viewerUrl: `/share/html/${token}` });
    }
    if (req.method === "PUT") {
      if (row.origin === "chat") return fail(res, 409, "not_uploadable", "this page was published from a chat");
      if (body?.expectedVersion !== row.version) {
        return fail(res, 409, "version_conflict", `expected version ${body?.expectedVersion}, current is ${row.version}`, { currentVersion: row.version });
      }
      const problem = preflight(body);
      if (problem) return fail(res, problem[0], problem[1], problem[2], problem[3]);
      const vis = resolveVisibility(body, row);
      if (Array.isArray(vis)) return fail(res, vis[0], vis[1], vis[2], vis[3]);
      Object.assign(row, {
        title: body.title,
        description: body.description ?? row.description,
        entry: body.entry ?? "index.html",
        files: normalizeFiles(body.files),
        ...vis,
        header: body.header === null ? null : body.header === undefined ? row.header : { showAuthor: false, ...body.header },
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      });
      return send(res, 200, view(row));
    }
    if (req.method === "PATCH") {
      const vis = resolveVisibility(body ?? {}, row);
      if (Array.isArray(vis)) return fail(res, vis[0], vis[1], vis[2], vis[3]);
      Object.assign(row, vis, {
        header: body?.header === null ? null : body?.header === undefined ? row.header : { showAuthor: false, ...body.header },
        updatedAt: new Date().toISOString(),
      });
      return send(res, 200, view(row));
    }
    if (req.method === "DELETE") {
      const expected = url.searchParams.get("expectedVersion");
      if (expected !== null && Number(expected) !== row.version) {
        return fail(res, 409, "version_conflict", "stale", { currentVersion: row.version });
      }
      row.deleted = true;
      return send(res, 204);
    }
    return fail(res, 405, "preflight_failed", "method not allowed");
  });
  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const url = `http://${host}:${server.address().port}`;
  return {
    url,
    store,
    requests,
    bump: async (id) => (await fetch(`${url}/__stub/bump/${id}`, { method: "POST" })).json(),
    chatPage: async () => (await fetch(`${url}/__stub/chat`, { method: "POST" })).json(),
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
  };
  const stub = await startStub({ apiKey: arg("--key", "rk-test"), orgs: arg("--orgs", "org_a").split(",").filter(Boolean), port: Number(arg("--port", "0")) });
  console.log(`listening ${stub.url}`);
}
