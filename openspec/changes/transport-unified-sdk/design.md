# Design: transport-unified-sdk

**One API surface → OpenAPI → typed SDK; the in-process path runs the SAME
assembled router (embedded = a transport swap, not a second protocol).**

Grounding: `design-notes/inventory.md` (our two current surfaces, file:line),
`design-notes/api-surface.json` (the concrete unified surface), and
`design-notes/prototype/` (a runnable proof of the transport-swap mechanism).
Reference: opencode `packages/{server,sdk,sdk-next}`.

---

## 架構總覽

```
                  ┌───────────────────────────────────────────────┐
                  │   ONE API definition  (api-surface.json)       │
                  │   session/turn ops + the event union           │
                  └───────────────┬───────────────────────────────┘
              generate            │             generate
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                          ▼
   openapi.json            typed SDK client            (contract tests)
   (served @ /openapi.json) (@hey-api/openapi-ts)
                                  │  the client wraps an INJECTABLE fetch
                 ┌────────────────┴─────────────────┐
                 ▼                                   ▼
         REMOTE transport                    EMBEDDED transport
         fetch → HTTP socket                 fetch → in-memory web handler
                 │                                   │ (no port, no I/O)
                 ▼                                   ▼
   ┌───────────────────────┐        ┌─────────────────────────────────┐
   │  Rust app-server       │        │  ASSEMBLED ROUTER (JS)          │
   │  hosts the router over │        │  routing+middleware+handlers+   │
   │  hyper (Backend impl B)│        │  codecs → (Request)=>Response   │
   └───────────┬───────────┘        │  Backend impl A: agent-core     │
               │                     └───────────────┬─────────────────┘
       Backend adapter                       Backend adapter
       (JSON-RPC ⇄ ops, or native)           (engine.mjs send/steer/...)
               │                                     │
               ▼                                     ▼
        codex-rs turn loop                   agent-runtime/src/engine.mjs
```

The **client surface is identical** on both transports. "Embedded vs remote" is
the choice of which `fetch` the generated client is given — nothing else changes
(mirrors opencode `sdk-next/src/opencode.ts:32-38`). VS Code, a future web share
page, and a slim CLI all consume this one client.

---

## 關鍵決策

### D1: The ONE API surface = the core turn loop, not all ~150 methods
`inventory.md §A.4` shows the VS Code panel drives only the turn loop and
delegates auth/history to CLI + filesystem. So the unified v1 surface is small
and closes over exactly what both transports must agree on. Full list (see
`api-surface.json` for shapes):

| # | Operation | Method + path | Replaces (Rust / JS) |
|---|---|---|---|
| 1 | `global.health` | `GET /health` | — |
| 2 | `global.capabilities` | `GET /capabilities` | — (new; reconciliation seam) |
| 3 | `config.get` | `GET /config` | `initialize`+`model/list` / `models`,`webAccess` |
| 4 | `session.list` | `GET /session` | `thread/list` / `listSessions` |
| 5 | `session.create` | `POST /session` | `thread/start` / `newChat` |
| 6 | `session.get` | `GET /session/{id}` | `thread/resume` / `loadSession` |
| 7 | `session.history` | `GET /session/{id}/history` | `thread/read` / `messages` |
| 8 | `session.prompt` | `POST /session/{id}/prompt` | `turn/start`(+`turn/steer`) / `send`+`steer` |
| 9 | `session.interrupt` | `POST /session/{id}/interrupt` | `turn/interrupt` / host abort |
| 10 | `session.compact` | `POST /session/{id}/compact` | `thread/compact/start` / implicit |
| 11 | `session.setWebAccess` | `POST /session/{id}/web-access` | — / `setWebAccess` |
| 12–14 | `session.revert.{stage,clear,commit}` | `POST /session/{id}/revert/*` | — / checkpoints (restore TBD) |
| 15 | `session.permission.reply` | `POST /session/{id}/permission/{reqId}/reply` | `item/*/requestApproval` resp / `approvalReply` |
| 16–17 | `session.question.{reply,reject}` | `POST /session/{id}/question/{reqId}/{reply,reject}` | `item/tool/requestUserInput` resp / `questionReply` |
| 18 | `session.events` | `GET /session/{id}/event` (SSE) | notification stream / `onText`+`onToolEvent` |

**18 operations** + a single **`SessionEvent` union** (8 event kinds:
`message.delta`, `reasoning.delta`, `item.upsert`, `turn.state`,
`permission.request`, `question.request`, `context.compacted`, `steer.applied`).
This is deliberately opencode's `v2.session.*` shape (`inventory.md §D`) so we
inherit a proven contract rather than reinventing one.

### D2: The in-process path runs the SAME assembled router (THE key idea)
The router is written **once** as a single web handler
`(Request) => Promise<Response>` that owns routing + middleware + JSON codecs +
the uniform error envelope, and dispatches to a `Backend` interface
(`prototype/router.mjs`). It performs **no network I/O of its own** — being
reached over a socket or called directly is a *caller's* transport choice.

- **Remote**: an HTTP listener pipes each incoming request into the handler and
  streams the `Response` back (`prototype/equivalence.test.mjs startRemote`).
  The Rust app-server hosts this same router over hyper (Backend B).
- **Embedded**: `createEmbeddedFetch(backend)` returns a `fetch` that calls
  `handler(new Request(...))` directly — no port, no socket
  (`prototype/client.mjs`). The generated SDK client is constructed with that
  `fetch`; every call runs the identical routing/handlers/codecs/errors in
  memory.

This is exactly opencode's mechanism, reproduced without Effect:

```
// opencode packages/sdk-next/src/opencode.ts:20-38 (paraphrased)
const web   = HttpRouter.toWebHandler(createEmbeddedRoutes(), ...) // same routes
const fetch = (input, init) => web.handler(new Request(input, init)) // no socket
const client = OpenCode.make({ baseUrl: "http://opencode.local" })
                 .provideService(FetchHttpClient.Fetch, fetch)        // swap transport
```

Our `prototype/{router,client,demo-backend,equivalence.test}.mjs` demonstrate the
whole loop end to end and assert embedded≡remote for results, errors, and SSE.

**Why this matters:** a new feature (e.g. `session-render-web-share`,
`session-checkpoint-revert`) is added to the API surface once; both transports
and all clients get it with no per-client wiring — killing the "wire every
feature twice" problem (`inventory.md §C`).

### D3: Two backends behind ONE contract, differences via capability flags
The router dispatches to a `Backend` interface; there are two implementations,
neither of which is a second protocol:

- **Backend A (JS agent-core)** — a thin adapter over
  `agent-runtime/src/engine.mjs`: `prompt→send`/`steer`, `interrupt→abort`,
  `setWebAccess→setWebAccess`, `history→messages/session.mjs`,
  `revert→snapshot.mjs` (restore is the new work), events mapped from
  `onText`/`onToolEvent`/loop events up to the `SessionEvent` union.
- **Backend B (Rust app-server)** — either (b1) a JS adapter that translates
  ops ⇄ the existing JSON-RPC methods (`inventory.md §A.1-A.3`) as a migration
  bridge, or (b2, end state) Rust natively hosts the OpenAPI router over hyper
  (the app-server serves `/session/*` + `/openapi.json`).

Where the two genuinely differ (`inventory.md §C`), the API does **not** fork.
`GET /capabilities` reports booleans (`steer`, `queue`,
`revert.stage_commit_clear`, `question`, `compact`, `web_access`, `checkpoints`,
`share`); clients hide/disable unsupported affordances. Unsupported ops return a
uniform `501 unsupported` through the same client call (proven in
`equivalence.test.mjs` "capability gap" test). `InputAdmitted.delivered=false`
carries the steer-not-supported case — the exact signal the panel already uses
(`extension.ts:191-197`).

### D4: OpenAPI + SDK generation pipeline
- **Spec is the source of truth, generated, not hand-maintained.** In JS the
  assembled router is annotated per-route and a `generate` step emits
  `openapi.json` (opencode: `OpenApi.fromApi(PublicApi)`,
  `server.ts:67-69`, served at `/openapi.json`, `routes.ts:53-61`). For our
  plain-JS router, either (a) adopt a lightweight typed-route framework that can
  emit OpenAPI, or (b) keep `api-surface.json` as the authored spec and validate
  the router against it in CI (contract test). `design-notes/api-surface.json` is
  that spec today.
- **SDK is generated from the spec** with `@hey-api/openapi-ts` (opencode
  `packages/sdk/js/script/build.ts:47-72`): `createClient({ input:
  "openapi.json", output, plugins: [@hey-api/typescript, @hey-api/sdk,
  @hey-api/client-fetch] })`. Crucially `@hey-api/client-fetch` produces a client
  whose `fetch`/`baseUrl` are overridable — that override is D2's swap point.
- **Placement**: new package `sdk/js-unified` (sibling of the existing
  `sdk/typescript`, `sdk/python`); spec at `sdk/js-unified/openapi.json`; the
  in-memory router + JS backend adapter live in the agent-runtime package;
  the VS Code extension depends on the generated client.

### D5: Events — one durable, replayable SSE stream
Both transports converge on `GET /session/{id}/event` (SSE) carrying the
`SessionEvent` union, with `?after=<seq>` durable replay then live tail (opencode
`v2.session.events`, `session.ts:327-343`; sdk-next replays durable events after
an aggregate seq). This subsumes the Rust notification stream and the JS
`onText`/`onToolEvent` callbacks. The JS backend maps its coarser events up to
the finer union; the Rust backend maps its fine-grained `item/*` notifications
down/through. The VS Code webview protocol (`turnDelta`/`itemUpsert`/`turnState`/
`approvalRequest`/`questionRequest`, `agentCoreBackend.ts`) becomes a thin render
adapter over this one stream instead of two bespoke bridges.

---

## Migration plan (staged, low-risk, reversible)

**Stage 0 — Define (this change).** Author `api-surface.json`; land the
`prototype/` proof (router + embedded/remote client + equivalence tests). No
production code touched. ✅ delivered here.

**Stage 1 — Spec + SDK pipeline.** Stand up the generated `openapi.json` +
`@hey-api/openapi-ts` codegen into `sdk/js-unified`. CI: `openspec validate`,
codegen determinism, spec↔router contract test. *Risk:* codegen drift — mitigate
with the patch-guard pattern opencode uses (`build.ts:74-113` throws if patches
don't apply).

**Stage 2 — Embedded router over the JS agent-core backend.** Implement Backend A
(adapter over `engine.mjs`) + the in-memory web handler; wire the SSE event union
mapping. Ship behind a flag; run the equivalence tests. *Risk:* event-granularity
mismatch — the union is authored at the finer (Rust) granularity so JS only needs
to coarsen-up, never lose data.

**Stage 3 — Move the VS Code panel onto the SDK (parallel, then default).** Add a
third engine `unified` in `extension.ts` next to `app-server`/`agent-core`,
backed by the embedded client. Re-express the webview protocol as a render
adapter over `SessionEvent`. Keep the old paths as fallback (matches the existing
`chat-panel-app-server` fallback discipline). Flip default only after regression
(`tasks 6.2`). *Risk:* behavioral drift in the panel — gated by keeping both
paths live and a smoke checklist.

**Stage 4 — Remote transport = Rust app-server hosting the router.** Backend B:
start with the JSON-RPC translation bridge (b1) so the remote transport works
immediately over the existing app-server; then converge to native OpenAPI hosting
in Rust (b2). At this point embedded and remote are literally the same router
with two backends. *Risk:* Rust/JS capability parity — expressed through
`/capabilities`, not divergent clients; the deprecated JSON-RPC surface stays
until b2 lands.

**Stage 5 — Converge + retire.** Once the panel is default-on the SDK and both
backends pass contract tests, retire the bespoke webview bridges and the
hand-wired app-server client. New features (`session-render-web-share`) build only
on the client surface.

---

## 風險 (biggest, with mitigations)

1. **Cross-language contract skew (Rust vs JS).** Two independent
   implementations of one spec drift. → Single authored spec + a shared
   **contract test suite** run against *both* backends (the `equivalence.test.mjs`
   pattern generalized); `/capabilities` makes intentional gaps explicit and
   test-asserted rather than silent.
2. **Revert is not actually implemented yet on JS** (restore deliberately omitted,
   `snapshot.mjs:10-13`, `engine.mjs:280-281`). The API defines
   stage/clear/commit but Backend A must build real restore
   (`session-checkpoint-revert` change). Until then capability
   `revert.stage_commit_clear=false` and the ops 501. → sequence Stage 2 after or
   alongside that change; keep the flag honest.
3. **OpenAPI generation for a plain-JS router.** Effect gives opencode free
   OpenAPI; our router doesn't. → either adopt a typed-route lib that emits
   OpenAPI, or treat `api-surface.json` as authored truth and enforce
   router↔spec agreement in CI. Chosen for v1: authored spec + contract test
   (lower dependency risk).
4. **SSE over the embedded transport.** The in-memory `fetch` must return a
   `Response` with a streaming `text/event-stream` body the client decodes with
   no socket. → proven in `prototype/` (ReadableStream body + client SSE parser);
   opencode confirms this works in-process (`sdk-next` routes SSE through the same
   `fetch`).
5. **Panel regression during migration.** → keep `app-server`/`agent-core` paths
   live as fallback (established discipline in `chat-panel-app-server` D6); flip
   default only after `tasks 6.2` regression passes.
6. **Auth/history intentionally out of the v1 surface** (delegated to CLI +
   rollout scan today). → keep them out of the turn-loop contract for v1; expose
   only `signedIn`/session listing; fold in later without breaking the surface.
