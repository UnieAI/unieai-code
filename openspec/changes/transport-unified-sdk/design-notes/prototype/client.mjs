// prototype/client.mjs
//
// The typed SDK, reduced to its essence. In the real change this file is
// GENERATED from api-surface.json by @hey-api/openapi-ts (see design.md).
// The generated client is a thin wrapper over an INJECTABLE `fetch` -- that
// injection point is the entire transport-swap mechanism.
//
//   remote  : inject global fetch -> hits `unieai app-server` over HTTP.
//   embedded: inject a fetch that calls the in-memory router web handler
//             directly (createEmbeddedFetch). No socket, no port.
//
// Mirrors opencode sdk-next (packages/sdk-next/src/opencode.ts:32-38): a `fetch`
// shim handed to the generated client; and packages/sdk/js/script/build.ts
// (@hey-api/client-fetch, overridable baseUrl/fetch).

import { createRouter } from "./router.mjs";

/** Build an in-memory `fetch` bound to an assembled router (the embedded transport). */
export function createEmbeddedFetch(backend) {
  const handler = createRouter(backend);
  const f = (input, init) => handler(new Request(input, init));
  f.preconnect = () => undefined;
  return f;
}

/** Generated-client stand-in. Accepts `{ baseUrl, fetch }` like @hey-api/client-fetch. */
export function createClient({ baseUrl = "http://unieai.local", fetch: fetchImpl = globalThis.fetch } = {}) {
  const call = async (method, path, body) => {
    const init = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await fetchImpl(baseUrl + path, init);
    if (!res.ok) {
      let detail;
      try { detail = await res.json(); } catch { detail = { error: { code: "http", message: res.statusText } }; }
      const err = new Error(detail?.error?.message || res.statusText);
      err.status = res.status; err.code = detail?.error?.code;
      throw err;
    }
    if (res.status === 200 && res.headers.get("content-type")?.includes("application/json")) return res.json();
    return undefined;
  };

  const enc = (s) => encodeURIComponent(s);
  return {
    health: () => call("GET", "/health"),
    capabilities: () => call("GET", "/capabilities"),
    getConfig: () => call("GET", "/config"),
    sessions: {
      list: () => call("GET", "/session"),
      create: (input) => call("POST", "/session", input),
      get: (id) => call("GET", `/session/${enc(id)}`),
      history: (id, q = {}) => {
        const p = new URLSearchParams();
        if (q.limit != null) p.set("limit", String(q.limit));
        if (q.after != null) p.set("after", String(q.after));
        const qs = p.toString();
        return call("GET", `/session/${enc(id)}/history${qs ? "?" + qs : ""}`);
      },
      prompt: (id, input) => call("POST", `/session/${enc(id)}/prompt`, input),
      interrupt: (id) => call("POST", `/session/${enc(id)}/interrupt`),
      compact: (id) => call("POST", `/session/${enc(id)}/compact`),
      setWebAccess: (id, value) => call("POST", `/session/${enc(id)}/web-access`, { value }),
      revert: {
        stage: (id, input) => call("POST", `/session/${enc(id)}/revert/stage`, input),
        clear: (id) => call("POST", `/session/${enc(id)}/revert/clear`),
        commit: (id) => call("POST", `/session/${enc(id)}/revert/commit`),
      },
      permission: {
        reply: (id, reqId, input) => call("POST", `/session/${enc(id)}/permission/${enc(reqId)}/reply`, input),
      },
      question: {
        reply: (id, reqId, input) => call("POST", `/session/${enc(id)}/question/${enc(reqId)}/reply`, input),
        reject: (id, reqId) => call("POST", `/session/${enc(id)}/question/${enc(reqId)}/reject`),
      },
      async *events(id, { after } = {}) {
        const qs = after != null ? `?after=${after}` : "";
        const res = await fetchImpl(baseUrl + `/session/${enc(id)}/event${qs}`, { method: "GET" });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) yield JSON.parse(dataLine.slice(6));
          }
        }
      },
    },
  };
}

/** Convenience: an embedded client (in-memory router) over a backend. */
export function createEmbeddedClient(backend) {
  return createClient({ baseUrl: "http://unieai.local", fetch: createEmbeddedFetch(backend) });
}
