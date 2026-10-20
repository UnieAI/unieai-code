#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-ava-artifacts-stub.mjs — an in-memory stand-in for ava's artifact
 * routes (docs/unieai/artifacts-spec.md), until ava ships them.
 *
 *   node scripts/unieai-ava-artifacts-stub.mjs [--port 0] [--key rk-test]
 *
 * prints `listening <url>` and serves:
 *   POST   /api/agent-next/artifacts/site
 *   PUT    /api/agent-next/artifacts/:id          (409 on a stale expectedVersion)
 *   GET    /api/agent-next/artifacts?mine=1&source=unieai-code
 *   GET    /api/agent-next/artifacts/:id
 *   DELETE /api/agent-next/artifacts/:id
 *   GET    /share/html/:token                      (the entry page)
 * with ava's error shape `{error:{code,message}}`, its limits, a preflight
 * that rejects external http(s) references, and bearer-key auth.
 * POST /__stub/bump/:id simulates an edit in ava's web UI (a new version).
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const ROUTE = "/api/agent-next/artifacts";
const MiB = 1024 * 1024;
const LIMITS = { file: 4 * MiB, deps: 12 * MiB, depCount: 48, share: 16 * MiB };

const send = (res, status, body) => {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};
const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });

function preflight(body) {
  if (typeof body?.title !== "string" || !body.title.trim()) return [400, "bad_request", "title is required"];
  if (body.visibility && !["private", "org"].includes(body.visibility)) return [400, "bad_request", "visibility must be private or org"];
  if (!Array.isArray(body.files) || !body.files.some((file) => file.path === body.entry)) return [400, "bad_request", "entry is not among files"];
  let deps = 0;
  let total = 0;
  for (const file of body.files) {
    const size = Buffer.from(String(file.contentBase64 ?? ""), "base64").length;
    if (size > LIMITS.file) return [413, "too_large", `${file.path} is over 4 MiB`];
    total += size;
    if (file.path !== body.entry) deps += size;
    if (/\.(html?|css|m?js)$/i.test(file.path)) {
      const text = Buffer.from(file.contentBase64, "base64").toString("utf8");
      const ref = text.match(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']|url\(\s*["']?(https?:\/\/[^"')]+)/i);
      if (ref && !/<a\s[^>]*$/i.test(text.slice(0, ref.index))) {
        return [422, "external_ref", `external reference ${ref[1] ?? ref[2]} in ${file.path}`, { path: file.path }];
      }
    }
  }
  if (body.files.length - 1 > LIMITS.depCount) return [413, "too_large", "more than 48 dependencies"];
  if (deps > LIMITS.deps || total > LIMITS.share) return [413, "too_large", "share over the size limit"];
  return null;
}

/** Start the stub. @returns {Promise<{url, store, requests, bump, close}>} */
export async function startStub({ apiKey = "rk-test", port = 0, host = "127.0.0.1" } = {}) {
  const store = new Map();
  const requests = [];
  let next = 1;
  const view = (row) => ({ id: row.id, viewerUrl: `/share/html/${row.token}`, version: row.version });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://stub");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      fail(res, 400, "bad_request", "body is not JSON");
      return;
    }
    requests.push({ method: req.method, path: url.pathname, query: url.search, authorized: req.headers.authorization === `Bearer ${apiKey}`, body });

    const share = url.pathname.match(/^\/share\/html\/([\w-]+)$/);
    if (req.method === "GET" && share) {
      const row = [...store.values()].find((r) => r.token === share[1] && !r.deleted);
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
      row.files = [...row.files.filter((f) => f.path !== "notes.txt"), { path: "notes.txt", mime: "text/plain", contentBase64: Buffer.from(`edited in the web UI (v${row.version})`).toString("base64") }];
      return send(res, 200, view(row));
    }
    if (!url.pathname.startsWith(ROUTE)) return fail(res, 404, "not_found", "no such route");
    if (req.headers.authorization !== `Bearer ${apiKey}`) return fail(res, 401, "unauthorized", "missing or invalid desktop key");
    const rest = url.pathname.slice(ROUTE.length);

    if (req.method === "POST" && rest === "/site") {
      const problem = preflight(body);
      if (problem) return fail(res, problem[0], problem[1], problem[2], problem[3]);
      const id = `art_${next++}`;
      const row = {
        id,
        token: randomBytes(9).toString("base64url"),
        title: body.title,
        description: body.description ?? null,
        entry: body.entry,
        files: body.files,
        visibility: body.visibility ?? "private",
        header: body.header ?? null,
        version: 1,
        source: "unieai-code",
        updatedAt: new Date().toISOString(),
      };
      store.set(id, row);
      return send(res, 201, view(row));
    }
    if (req.method === "GET" && rest === "") {
      if (url.searchParams.get("mine") !== "1") return fail(res, 400, "bad_request", "mine=1 is required");
      const source = url.searchParams.get("source");
      const rows = [...store.values()].filter((r) => !r.deleted && (!source || r.source === source));
      return send(res, 200, rows.map((r) => ({ id: r.id, title: r.title, url: `/share/html/${r.token}`, version: r.version, updatedAt: r.updatedAt })));
    }
    const one = rest.match(/^\/([\w-]+)$/);
    if (!one) return fail(res, 404, "not_found", "no such route");
    const row = store.get(one[1]);
    if (!row || row.deleted) return fail(res, 404, "not_found", "no such artifact");
    if (req.method === "GET") {
      const { token, deleted, source, ...meta } = row;
      return send(res, 200, { ...meta, viewerUrl: `/share/html/${token}` });
    }
    if (req.method === "PUT") {
      if (body?.expectedVersion !== row.version) {
        return fail(res, 409, "version_conflict", `expected version ${body?.expectedVersion}, current is ${row.version}`, { currentVersion: row.version });
      }
      const problem = preflight(body);
      if (problem) return fail(res, problem[0], problem[1], problem[2], problem[3]);
      Object.assign(row, {
        title: body.title,
        description: body.description ?? row.description,
        entry: body.entry,
        files: body.files,
        visibility: body.visibility ?? row.visibility,
        header: body.header ?? row.header,
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      });
      return send(res, 200, view(row));
    }
    if (req.method === "DELETE") {
      row.deleted = true;
      return send(res, 204);
    }
    return fail(res, 405, "bad_request", "method not allowed");
  });
  await new Promise((resolveListen) => server.listen(port, host, resolveListen));
  const url = `http://${host}:${server.address().port}`;
  return {
    url,
    store,
    requests,
    bump: async (id) => (await fetch(`${url}/__stub/bump/${id}`, { method: "POST" })).json(),
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : fallback;
  };
  const stub = await startStub({ apiKey: arg("--key", "rk-test"), port: Number(arg("--port", "0")) });
  console.log(`listening ${stub.url}`);
}
