# Inventory: the two current transports (grounded, file:line)

This is the evidence base for `design.md`. It enumerates what actually exists in
each of the two transports today, so the unified API is derived from reality —
not invented. All paths are absolute; line numbers verified 2026-07.

---

## A. Rust `unieai app-server` (JSON-RPC over stdio)

The protocol is generated from four declarative macros in one file:
`codex-rs/app-server-protocol/src/protocol/common.rs`.

- Client→server **requests**: `client_request_definitions!` — `common.rs:472-1221` (macro `:198`)
- Server→client **requests** (approvals/elicitations): `server_request_definitions!` — `common.rs:1482-1553` (macro `:1227`)
- Server→client **notifications**: `server_notification_definitions!` — `common.rs:1637-1740` (macro `:1391`)
- Client→server **notifications**: `client_notification_definitions!` — `common.rs:1761-1763` (macro `:1447`)

Wire method name = the `=> "..."` literal, else camelCase of the variant
(`#[serde(tag="method", rename_all="camelCase")]`, `common.rs:214`). Request
param/response types live in `protocol/v2/*.rs` (new) and `protocol/v1.rs`
(deprecated). Envelope has no `jsonrpc` field (`app-server-protocol/src/rpc.rs`).
Dispatch: `codex-rs/app-server/src/request_processors.rs`, `message_processor.rs`.

The protocol is **large (~150 client requests, 11 server requests, ~70
notifications)**. The VS Code panel uses a tiny slice of it (see A.4).

### A.1 Client→server requests actually used by the panel
The transport (`sdks/vscode/src/appServerClient.ts`) is generic — no method
names hardcoded. All concrete method strings are in `extension.ts`:

| Wire method | protocol def (common.rs) | panel call (extension.ts) | unified op |
|---|---|---|---|
| `initialize` | :473 | :666 (sends `capabilities.experimentalApi:true`) | (bootstrap → `GET /config` + `GET /capabilities`) |
| `thread/resume` | :488 | :1086 | `GET /session/{id}` (resume) |
| `thread/start` | :482 | :1092 (`{model,cwd,approvalPolicy,sandbox,config}`) | `POST /session` |
| `thread/settings/update` | :560 | :1111 (sandbox/approval change) | `PATCH /config` (session-scoped) |
| `turn/start` | :822 | :1128 (`{threadId,input:[{type:"text",text}],model?}`) | `POST /session/{id}/prompt` |
| `turn/interrupt` | :834 | :621 (`{threadId,turnId}`) | `POST /session/{id}/interrupt` |

Note `turn/steer` EXISTS (`common.rs:828`) but the panel does **not** call it on
the app-server path — steering is only wired on the JS engine (extension.ts:188-199).

### A.2 Server→client requests handled by the panel
Registered at `extension.ts:650`; dispatched in `handleServerRequest` (`:936`):

| Wire method | protocol def | panel handling | unified op |
|---|---|---|---|
| `item/commandExecution/requestApproval` | :1486 | :943 → `{decision}` (resolveApproval :1016) | `POST /session/{id}/permission/{reqId}/reply` |
| `item/fileChange/requestApproval` | :1493 | :944 (same) | same |
| `item/permissions/requestApproval` | :1511 | :945 (same) | same |
| `item/tool/requestUserInput` | :1499 | :982 → `{answers}` (:216) | `POST /session/{id}/question/{reqId}/reply` |
| any other server request | — | :1000 declined with `{}` | n/a |

### A.3 Notifications the panel subscribes to
`handleNotification` (`extension.ts:690`), the streamed event set:

`item/started` (:692), `item/completed` (:693), `item/agentMessage/delta` (:700),
`item/reasoning/textDelta` (:703), `item/reasoning/summaryTextDelta` (:704),
`item/commandExecution/outputDelta` (:712), `item/plan/delta` (:720),
`item/fileChange/patchUpdated` (:723), `item/mcpToolCall/progress` (:740),
`thread/tokenUsage/updated` (:748), `item/autoApprovalReview/started` (:755),
`item/autoApprovalReview/completed` (:756),
`item/commandExecution/terminalInteraction` (:761), `turn/completed` (:766),
`error` (:779). Everything else falls through `default: break` (:784).

Protocol defs for these: `common.rs:1663,1666,1671,1700,1698,1682,1673,1686,1688,1656,1664,1665,1683,1659,1639`.

### A.4 What the panel does NOT use (delegated elsewhere or unused)
- **Auth/account** — done out-of-band by spawning `unieai login` / `unieai logout`
  CLI subprocesses (`extension.ts:317-405`), NOT via `account/*` JSON-RPC. Never
  subscribes to `account/updated`, `account/login/completed`, etc.
- **History/list** — `listSessions` (`extension.ts:409`) and `loadSession` (`:546`)
  read rollout `.jsonl` files directly from `sessionsDir()`, bypassing
  `thread/list`, `thread/read`, `thread/loaded/list`, `getConversationSummary`.
- **Steering** — `turn/steer` (`common.rs:828`) unused on this path.
- Unused whole domains: config/models/skills/hooks/marketplace/plugins/apps,
  `fs/*`, `command/exec*`, `process/*`, `mcp*`, `remoteControl/*`, `environment/*`,
  `windowsSandbox/*`, `feedback/upload`, `fuzzyFileSearch*`, `realtime/*`,
  `thread/fork|archive|delete|rollback|compact/start|name/set|goal/*`, and all
  deprecated v1 requests.

**Takeaway:** the panel drives only the core turn loop
(initialize → thread/start|resume → turn/start → stream item/turn notifications →
answer approval/user-input server requests → turn/interrupt). The unified API
only needs to cover that loop + capability-flagged extras — not all ~150 methods.

---

## B. In-process JS agent-core engine

Three files: the engine (`agent-runtime/src/engine.mjs`), the loop that emits
events (`third_party/unieai-agent-core/src/loop.mjs`), and the VS Code bridge
(`sdks/vscode/src/agentCoreBackend.ts` + host wiring in `extension.ts`).

### B.1 Engine public surface — `agent-runtime/src/engine.mjs`
`createEngine(opts)` factory (`:242-253`) returns a plain object:

| Member | Signature / shape | file:line | unified op |
|---|---|---|---|
| `sessionId` | string | :383 | session id |
| `model` / `models` | active id / `[{id,name?}]` | :384-385 | `GET /config` |
| `messages` | live chat history array | :386 | `GET /session/{id}/history` |
| `get webAccess()` | boolean | :388-390 | `GET /config` |
| `get checkpoints()` | copy of `[{messageIndex, tree}]` | :392-395 | (revert basis) |
| `setWebAccess(value)` | void; drops toolset cache, keeps session | :397-404 | `POST /session/{id}/web-access` |
| `send(text,{abortSignal})` | `Promise<{finishReason,steps,usage,answerText,toolCallCount}>`; serialized via turn coordinator | :406-411 (impl `runTurn` :429-523) | `POST /session/{id}/prompt` (delivery=default) |
| `isBusy()` | boolean; turn in flight | :413-415 | (derivable from `turn.state`) |
| `steer(text)` | boolean; pushes to `steerQueue`, returns whether a turn is running | :417-426 | `POST /session/{id}/prompt` (delivery=steer) |

`runTurn` also: context refresh + compact delta (:433-440), between-turn semantic
compaction `compactWithSummary` remapping checkpoint indices (:473-503), workspace
checkpoint `snapshotWorkspace` (:505-511), persist `saveSession` (:513-521).

### B.2 Events emitted — `third_party/unieai-agent-core/src/loop.mjs`
Three callbacks via `emitter` (`engine.mjs:360-365`): `onText` (:361),
`onReasoning` (:362), `onToolEvent` (:364; `writeMetadata` is a no-op :363).
All structured events flow through `onToolEvent`; shapes in loop.mjs:

`history_repair` (:215), `steer` `{text}` (:238), `context_prune` (:282,:486),
`completion_nudge` (:321), `tool_use_started` `{tool_use_id,tool_name,args_preview}`
(:366), `tool_use_completed`/`tool_use_failed` `{...,output_preview}` (:370,:400,:430-435),
custom `timelineEvent` (:428), `doom_warning` (:464,:468). Loop return
`{finishReason,steps,usage,answerText,toolCallCount}` (:490; `finishReason` ∈
`stop|tool_calls|failed`).

### B.3 Webview message protocol — `agentCoreBackend.ts` + `extension.ts`
Types: `ApprovalDecision = "accept"|"acceptForSession"|"decline"|"cancel"`
(`agentCoreBackend.ts:17`); `AgentCoreCallbacks` `{post, requestApproval, requestQuestion}`
(`:19-25`).

**Outbound (backend→webview) `cb.post`:** `itemUpsert` (agent message :48-54; tool
start :124-135; tool end :139-150), `turnDelta` (agent :88; reasoning :91-96),
`running` (:179,:193,:201), `turnState` (idle/failed :185,:190; interrupted :200),
`stderr` (:191). Host-generated: `approvalRequest {id,kind,detail}`
(`extension.ts:136-141`), `questionRequest {id,question,options}` (`:147`).

**Inbound (webview→backend), `extension.ts` switch (:170-285):** `ready` (:171),
`send {text,model?,sandbox?,webAccess}` (:174 → `send` at :1052), `setWebAccess`
(:182), `stop` (:185 → `interrupt` :616), `steer {text,id}` (:188 → replies
`steerAck {id,delivered}` :198), `approvalReply {id,decision}` (:201),
`questionReply {id,answer}` (:204), `userInputReply {id,answers}` (:212, app-server
path), `retry` (:220), `newChat` (:226), `login`/`logout` (:229-233),
`listSessions` (:279), `loadSession {path}` (:282 → `resume` :541), plus editor
actions.

### B.4 Capability map (engine concept → unified op)
| Concept | Engine | Backend | Unified op | Capability flag |
|---|---|---|---|---|
| Prompt | `send` | `.send` :168 | `POST /prompt` (default) | — |
| Interrupt | host AbortController | `interrupt` :198 | `POST /interrupt` | — |
| Steer | `steer` :422 | `steer` :215 | `POST /prompt` (steer) | `steer` |
| Queue | (outer drain) | — | `POST /prompt` (queue) | `queue` |
| Permission reply | `requestApproval` cb | :22 | `POST /permission/{id}/reply` | — |
| Question reply | `requestQuestion` cb | :24 | `POST /question/{id}/reply` | `question` |
| Revert | `checkpoints` (accumulate-only; **restore NOT implemented**, snapshot.mjs:10-13, engine.mjs:280-281) | — (not surfaced) | `POST /revert/{stage,clear,commit}` | `revert.stage_commit_clear` |
| History/resume | `resume`→`loadSession` :260; `saveSession` :513 | `resume` :163 | `GET /history`, `GET /session/{id}` | — |
| Compact | `compactWithSummary` :473 (implicit) | — | `POST /compact` | `compact` |
| Web access | `setWebAccess` :398 | `send(...,webAccess)` | `POST /web-access` | `web_access` |

---

## C. Where the two surfaces DISAGREE (reconciled by the unified API)

| Concern | Rust app-server | JS engine | Unified reconciliation |
|---|---|---|---|
| **Steering** | `turn/steer` exists but panel doesn't use it | first-class `steer()` | `POST /prompt {delivery:steer\|queue}`; `InputAdmitted.delivered=false` + capability `steer` when backend lacks the seam (matches extension.ts:191-197) |
| **Revert/checkpoint** | none | shadow-git checkpoints, restore not yet wired | `POST /revert/{stage,clear,commit}` (opencode v2 shape); capability `revert.stage_commit_clear`; JS is the reference backend |
| **Auth** | `account/*` JSON-RPC | CLI subprocess | out of unified turn-loop scope v1; both expose `signedIn` via `GET /config`; auth flows tracked separately |
| **History** | `thread/read`/`thread/list` | rollout `.jsonl` scan | `GET /session`, `GET /session/{id}/history` — backend chooses source |
| **Approvals** | server→client REQUEST (elicitation), client responds by id | callback resolved by id | both → event `permission.request` + `POST /permission/{id}/reply`; decision enum normalized to `once\|always\|reject` |
| **Question vs permission** | `item/tool/requestUserInput` | separate `requestQuestion` cb | distinct `question.request` event + `/question/{id}/reply|reject` (turn-steering change) |
| **Compact** | `thread/compact/start` request + `thread/compacted` notif | implicit between turns | explicit `POST /compact` + `context.compacted` event; capability `compact` |
| **Event granularity** | fine-grained item/delta notifications | coarser `onText`/`onToolEvent` | unified `SessionEvent` union (api-surface.json) at the finer granularity; JS backend maps its coarse events up |
| **Streaming shape** | JSON-RPC notifications (push) | callbacks | per-session SSE `GET /session/{id}/event` with durable `after` replay (opencode `v2.session.events`) |

---

## D. opencode reference mapping (the target we mirror)

opencode's committed `packages/sdk/openapi.json` carries a **v2 surface** under
`/api/session/*` that is a near-exact template for our unified API. Source of
truth: one Effect `HttpApi` contract (`packages/protocol/src/api.ts:36-64`).

| opencode v2 operationId | path | our unified op |
|---|---|---|
| `v2.session.prompt` | `POST /api/session/{id}/prompt` (`groups/session.ts:205-224`; body `{id?,prompt,delivery?,resume?}` → `{data:SessionInputAdmitted}`) | `POST /session/{id}/prompt` |
| `v2.session.interrupt` | `POST …/interrupt` (`:345-358`) | `POST …/interrupt` |
| `v2.session.compact` | `POST …/compact` (`:226-239`) | `POST …/compact` |
| `v2.session.revert.stage\|clear\|commit` | `POST …/revert/*` (`:256-290`; stage body `{messageID,files?}` → `{data:RevertState}`) | `POST …/revert/*` |
| `v2.session.permission.reply` | `POST …/permission/{reqId}/reply` (`groups/permission.ts:119-131`; body `{reply}` reply∈`once\|always\|reject`) | `POST …/permission/{reqId}/reply` |
| `v2.session.question.reply\|reject` | `POST …/question/{reqId}/{reply,reject}` (`groups/question.ts:52-77`) | same |
| `v2.session.history` | `GET …/history?limit&after` (`:307-325`) | `GET …/history` |
| `v2.session.events` | `GET …/event` SSE, durable `after` replay (`:327-343`) | `GET …/event` |
| `v2.session.messages`/`message` | `GET …/message[/…]` | folded into `GET …/history` v1 |

OpenAPI is generated via `OpenApi.fromApi(PublicApi)`
(`packages/opencode/src/server/server.ts:67-69`) and served live at `/openapi.json`
(`packages/server/src/routes.ts:53-61`). SDK codegen: `@hey-api/openapi-ts@0.90.10`
`createClient({input, output, plugins:[typescript, sdk, client-fetch]})`
(`packages/sdk/js/script/build.ts:47-72`). In-process same-router:
`HttpRouter.toWebHandler(createEmbeddedRoutes())` → `fetch` shim →
`OpenCode.make({baseUrl}).provideService(FetchHttpClient.Fetch, fetch)`
(`packages/sdk-next/src/opencode.ts:20-38`).
