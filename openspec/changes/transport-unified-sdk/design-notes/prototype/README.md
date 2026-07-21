# Prototype: the transport-swap mechanism

A minimal, self-contained proof of `design.md` D2 — the same assembled router run
**embedded** (in-memory, no port) and **remote** (over a real socket) through the
**same client surface**. No dependency on `agent-runtime/`, `codex-rs/`, or
`sdks/vscode/`; it uses a demo backend so the mechanism is verifiable in isolation.

## Files
- `router.mjs` — the ONE assembled router as a `(Request) => Promise<Response>`
  web handler: routing + JSON codecs + uniform error envelope + SSE encoder,
  dispatching to a `Backend` interface. Mirrors opencode's
  `HttpRouter.toWebHandler` reduction (`packages/server/src/routes.ts`).
- `client.mjs` — the generated-SDK stand-in over an **injectable `fetch`**.
  `createEmbeddedFetch(backend)` = the in-memory transport;
  `createClient({baseUrl, fetch})` = the remote transport. Mirrors
  `packages/sdk-next/src/opencode.ts:32-38` + `@hey-api/client-fetch`.
- `demo-backend.mjs` — a trivial in-memory `Backend` standing in for both the JS
  agent-core adapter and the Rust app-server adapter; carries capability flags.
- `equivalence.test.mjs` — asserts embedded ≡ remote for results, error
  semantics, and SSE replay, and that a capability gap surfaces uniformly as a
  `501 unsupported` through the same client call (prototype of tasks 4.2 / 6.1).

## Run
```
cd design-notes/prototype
node --test equivalence.test.mjs
```
(Node 18+ for global `fetch`/`Request`/`ReadableStream`.)

## What it proves
1. "Embedded vs remote = transport swap": only the `fetch` handed to the client
   changes; routing/handlers/codecs/errors are identical.
2. A new operation is added in exactly one place (the router + the spec), and
   every client/transport gets it.
3. Capability differences between backends are expressed as data
   (`/capabilities` + `501 unsupported`), not as divergent client code.

This is a design artifact, not production code — the real router is generated
from `../api-surface.json` and the real backends wrap `engine.mjs` (JS) and the
app-server (Rust). See `../../design.md`.
