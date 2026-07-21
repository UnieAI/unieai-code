// prototype/router.mjs
//
// The ONE assembled router: routing + middleware + handlers + codecs, expressed
// as a single `(Request) => Promise<Response>` web handler. This is the exact
// shape opencode reduces its Effect HttpApi to via `HttpRouter.toWebHandler`
// (opencode packages/server/src/routes.ts `webHandler`). We reproduce the
// contract in plain JS so it works for the agent-core (JS) backend with zero
// framework lock-in. The Rust app-server hosts the SAME OpenAPI over hyper.
//
// Key property: this function performs NO network I/O of its own. Whether it is
// reached over a socket (remote) or called directly (embedded) is a transport
// choice made by the caller, not by the handler. That is the whole thesis of
// the change: "embedded vs remote = transport swap, not a second protocol."

/**
 * @typedef {(req: Request, ctx: RouteCtx) => Promise<Response> | Response} Handler
 * @typedef {{ params: Record<string,string>, backend: any }} RouteCtx
 */

/** Minimal path-pattern router. Patterns use `:name` segments. */
function compile(pattern) {
  const parts = pattern.split("/").filter(Boolean);
  return (pathname) => {
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length !== parts.length) return null;
    const params = {};
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (parts[i] !== segs[i]) return null;
    }
    return params;
  };
}

/** JSON codec + uniform error envelope — shared by embedded and remote alike. */
function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}
function fail(status, code, message) {
  return json({ error: { code, message } }, { status });
}

/**
 * Assemble the router over a backend implementation. The backend is the ONLY
 * thing that differs between Rust and JS; the routing/codecs/errors are shared.
 * @param {object} backend - implements the operation methods (see handlers below)
 * @returns {(req: Request) => Promise<Response>} the web handler
 */
export function createRouter(backend) {
  /** @type {{ method: string, match: (p:string)=>any, handler: Handler }[]} */
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, match: compile(pattern), handler });

  // --- routing table (mirror of api-surface.json operationIds) ---
  on("GET", "/health", () => json({ ok: true, protocolVersion: "0.1.0", backend: backend.name }));
  on("GET", "/capabilities", () => json(backend.capabilities()));
  on("GET", "/config", async () => json(await backend.getConfig()));

  on("GET", "/session", async () => json(await backend.listSessions()));
  on("POST", "/session", async (req) => json(await backend.createSession(await req.json())));
  on("GET", "/session/:sessionID", async (_req, { params }) => json(await backend.getSession(params.sessionID)));
  on("GET", "/session/:sessionID/history", async (req, { params }) => {
    const u = new URL(req.url);
    return json(await backend.history(params.sessionID, {
      limit: numOrNull(u.searchParams.get("limit")),
      after: numOrNull(u.searchParams.get("after")),
    }));
  });

  on("POST", "/session/:sessionID/prompt", async (req, { params }) =>
    json(await backend.prompt(params.sessionID, await req.json())));
  on("POST", "/session/:sessionID/interrupt", async (_req, { params }) => {
    await backend.interrupt(params.sessionID);
    return new Response(null, { status: 200 });
  });
  on("POST", "/session/:sessionID/compact", async (_req, { params }) => {
    await backend.compact(params.sessionID);
    return new Response(null, { status: 200 });
  });
  on("POST", "/session/:sessionID/web-access", async (req, { params }) => {
    await backend.setWebAccess(params.sessionID, (await req.json()).value);
    return new Response(null, { status: 200 });
  });

  on("POST", "/session/:sessionID/revert/stage", async (req, { params }) =>
    json(await backend.revertStage(params.sessionID, await req.json())));
  on("POST", "/session/:sessionID/revert/clear", async (_req, { params }) => {
    await backend.revertClear(params.sessionID);
    return new Response(null, { status: 200 });
  });
  on("POST", "/session/:sessionID/revert/commit", async (_req, { params }) => {
    await backend.revertCommit(params.sessionID);
    return new Response(null, { status: 200 });
  });

  on("POST", "/session/:sessionID/permission/:requestID/reply", async (req, { params }) => {
    await backend.permissionReply(params.sessionID, params.requestID, await req.json());
    return new Response(null, { status: 200 });
  });
  on("POST", "/session/:sessionID/question/:requestID/reply", async (req, { params }) => {
    await backend.questionReply(params.sessionID, params.requestID, await req.json());
    return new Response(null, { status: 200 });
  });
  on("POST", "/session/:sessionID/question/:requestID/reject", async (_req, { params }) => {
    await backend.questionReject(params.sessionID, params.requestID);
    return new Response(null, { status: 200 });
  });

  // SSE — the event union. Same encoder for embedded and remote.
  on("GET", "/session/:sessionID/event", async (req, { params }) => {
    const u = new URL(req.url);
    const after = numOrNull(u.searchParams.get("after"));
    const stream = backend.events(params.sessionID, { after }); // async iterable of {event, ...}
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          for await (const evt of stream) {
            controller.enqueue(enc.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt)}\n\n`));
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  });

  // --- the web handler: dispatch + shared middleware/error envelope ---
  return async function handler(req) {
    let pathname;
    try { pathname = new URL(req.url).pathname; } catch { return fail(400, "bad_request", "invalid URL"); }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = r.match(pathname);
      if (!params) continue;
      try {
        return await r.handler(req, { params, backend });
      } catch (err) {
        if (err && err.code === "not_found") return fail(404, "not_found", err.message);
        if (err && err.code === "unsupported") return fail(501, "unsupported", err.message);
        return fail(500, "internal", String(err && err.message ? err.message : err));
      }
    }
    return fail(404, "not_found", `${req.method} ${pathname}`);
  };
}

function numOrNull(s) { return s == null ? null : Number(s); }
