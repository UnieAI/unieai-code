# UnieAI Code Remote Control — protocol v1

Status: v1, implemented by unieai-code (host side), by the reference relay in
`agent-runtime/src/remote-relay/`, and by its test page. The Ava (Rabi) team
implements the production relay and browser UI from this document alone.

Remote Control lets a person watch, steer, approve and answer a live local
`unieai` session from a browser or phone. Three parties take part:

| Party | Runs | Role |
|---|---|---|
| **Host** | the uac server on the user's machine (`agent-runtime/src/app-server/unieai-remote-bridge.mjs`) | holds the session; dials out to the relay; terminates end-to-end encryption |
| **Relay** | Ava (`agent.unieai.com`), or on-prem / the reference relay | authenticates the host, admits browsers to a room, forwards opaque frames |
| **Browser** | Ava's remote UI, or the reference test page | pairs once, then watches and drives the session |

The relay is untrusted for content: **it sees only ciphertext plus routing
metadata** (§9). Everything a person types, everything the model says, every
command and every approval decision travels inside a Noise channel between the
host and one browser.

Keywords MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. Overview

```
 browser ──HTTPS(SSE down, POST up)──▶ relay ◀──HTTPS(SSE down, POST up)── host (uac server)
    │                                    │                                      │
    └──────────── Noise channel (NKpsk0 to pair, IK to reconnect) ─────────────┘
                      JSON-RPC (app-server v2 subset) inside
```

1. The host registers with the relay using the user's existing UnieAI sign-in
   (Rabi desktop key or Studio access token) and gets a **room** (§3).
2. The host shows a **pairing link** / QR code. The secrets are in the URL
   fragment, which browsers never send to a server (§4).
3. The browser joins the room at the relay and runs a Noise **NKpsk0**
   handshake with the host, keyed by the host's static key and the pairing
   secret. The host adds the browser's static key to its **trust list** (§5, §6).
4. Later visits use a Noise **IK** handshake: the host recognises the browser by
   its static key; no secret is needed again until the device is revoked.
5. Inside the channel the browser speaks a whitelisted subset of the app-server
   v2 JSON-RPC protocol (§8). The host fans thread notifications and approval
   requests out to every attached client; the first answer wins.

Both endpoints dial *out* over plain HTTPS: server-sent events down, POST up.
This is the shape Rabi Local already uses (`/api/machines/relay/connect` +
`/result`), it works through Next.js route handlers and corporate proxies, and
it needs no inbound port on the user's machine.

---

## 2. Transport binding (HTTP)

All relay endpoints live under one base URL, the **relay base**:

| Deployment | Relay base |
|---|---|
| Ava (default) | `https://agent.unieai.com/api/remote` |
| On-prem Ava | `https://<ava-host>/api/remote` |
| Reference relay | `http://<host>:<port>/api/remote` |

The host resolves the relay base from, in order: the `--relay` flag of
`unieai remote-control start`, `UNIEAI_REMOTE_RELAY_URL`,
`$CODEX_HOME/remote-control/settings.json` (`relayUrl`), then the default.

### 2.1 Streams (down)

`GET <relay>/host/stream` and `GET <relay>/client/stream` answer
`200 text/event-stream`. Each event is one frame (§7):

```
data: {"t":"d","cid":"c_8Qk…","seq":12,"ack":4,"b":"…"}

```

- One frame per `data:` line; no `event:` or `id:` fields are used.
- The relay MUST send a comment line (`: ping`) at least every **15 s**.
  An endpoint that receives no bytes for **45 s** treats the stream as dead
  and reconnects.
- Browsers read the stream with `fetch()` and a body reader (so they can send
  an `Authorization` header), not `EventSource`.
- A stream ends when the session token is no longer valid; the relay answers a
  new stream request with `401` then.

### 2.2 Sends (up)

`POST <relay>/host/send` and `POST <relay>/client/send`, body
`{"frames": [frame, …]}` (at most 64 frames, at most 4 MiB). Answer:
`200 {"ok": true}`; for host sends, `"dropped": ["<cid>", …]` lists frames
whose client is not connected (the host keeps them for replay, §7.4).

### 2.3 Errors

Errors are `{"error": {"code": "<code>", "message": "<text>"}}` with HTTP status:
`401 invalid_token` (any authentication failure, indistinguishable by cause),
`403 forbidden`, `404 unknown_room`, `409 room_closed`, `413 too_large`,
`429 rate_limited` (with `Retry-After`), `502 upstream_unavailable`.

### 2.4 Reconnect

Endpoints reconnect a dead stream with exponential backoff: 1 s, 2 s, 4 s …
capped at 30 s, ±20 % jitter, reset after a stream has stayed up for 60 s. A
`401` on the host's stream means its host session expired: register again
(§3.1). A `401` on a browser stream means join again (§4.3).

---

## 3. Host registration and rooms

### 3.1 Register

```
POST <relay>/host/register
Authorization: Bearer <credential>
X-UnieAI-Account: rabi | studio
X-UnieAI-Origin: <origin the credential belongs to>
Content-Type: application/json

{ "protocol": 1, "hostId": "h_…", "hostName": "roy-mbp", "platform": "darwin",
  "version": "0.5.0" }
```

`credential` and origin come from `$CODEX_HOME/unieai.json`, which the existing
logins write:

| `account` | credential | origin |
|---|---|---|
| `rabi` | `access_token` (the long-lived desktop API key) | `studio_url` (e.g. `https://agent.unieai.com`) |
| `studio` (or absent) | `access_token` (OAuth access token; the TUI refreshes it) | `studio_url` (e.g. `https://studio.unieai.com`) |

`hostId` is a random id the host generates once and stores with its key pair
(§6.1); it is not derived from the key. `hostName` is the machine's hostname,
shown in Ava's machine list; a host MAY send an empty string.

**Validation (relay MUST do one of these and derive an owner id):**

| Account | Validation call | Owner |
|---|---|---|
| `rabi` | Ava: resolve the desktop key in-process exactly as `GET /api/desktop/me` does (`resolveIdentity`). A relay outside Ava calls `GET <origin>/api/desktop/me` with the same bearer and expects `200 {"user":{"id":…}}`. | `rabi:<user.id>` |
| `studio` | `GET <origin>/api/user` with the same bearer; expect `200` with the user (`email`, and `id` when present). | `studio:<origin>:<id or email>` |

- The relay MUST only accept origins on its own allowlist
  (`REMOTE_RELAY_ALLOWED_ORIGINS`); otherwise any server could vouch for any
  token. Ava's default allowlist is its own origin plus the Studio origins it
  serves.
- The relay MUST NOT store the credential. It MAY cache a successful
  validation for up to 5 minutes, keyed by a hash of the credential.

**Answer:**

```
200 { "roomId": "r_…", "hostSession": "<opaque>", "joinToken": "<opaque>",
      "webUrl": "https://agent.unieai.com/remote", "expiresAt": "<ISO-8601>" }
```

- `roomId`: stable for `(owner, hostId)` — the same host registering again gets
  the same room, so paired browsers find it after a restart. 128 bits of
  randomness, URL-safe.
- `hostSession`: bearer for `/host/stream`, `/host/send`, `/host/unregister`.
  Valid for at most 12 h; the host registers again on `401`.
- `joinToken`: admits browsers to this room (§4.3). It is a relay credential,
  not an E2E secret; the relay MAY rotate it on every register.
- `webUrl`: where the browser UI lives. The host builds the pairing link from
  it (§4.1). `UNIEAI_REMOTE_WEB_URL` overrides it on the host.

### 3.2 Room semantics

- A room has at most **one host stream**. A second `/host/stream` for the same
  room replaces the first (the old stream is closed) — the host process that
  registered last wins, as one uac server serves a machine.
- A room has at most **16 browser clients** (relay MAY lower it).
- When the host stream opens, the relay sends every connected browser
  `{"t":"host","state":"online"}` and sends the host an `open` frame for every
  connected browser. When it closes, browsers get `{"t":"host","state":"offline"}`.
- `POST <relay>/host/unregister` closes the room's streams; browsers get
  `{"t":"host","state":"closed"}`. The room id stays reserved for the owner.

---

## 4. Pairing

### 4.1 The pairing link

The host shows a link (and the same link as a QR code):

```
<webUrl>#v=1&relay=<relay base, percent-encoded>&room=<roomId>&join=<joinToken>
        &hk=<host static public key, base64url>&psk=<pairing secret, base64url>
        &name=<hostName, percent-encoded>
```

Everything after `#` is the **fragment**. Browsers never send it in an HTTP
request, so neither the web server that serves the page nor the relay learns
`hk` or `psk` from loading the link. The page reads `location.hash`, then
immediately replaces it (`history.replaceState`) so the secret does not stay in
the address bar, history sync or a screenshot.

- `psk`: 32 random bytes. **Single use**, valid **10 minutes**, one active
  pairing per host at a time (making a new link invalidates the old one).
- `hk`: the host's X25519 static public key (32 bytes).
- `relay` MAY be omitted when it is `<origin of webUrl>/api/remote`.

### 4.2 Base64url

All binary fields in this spec are unpadded base64url (RFC 4648 §5).

### 4.3 Joining the room

```
POST <relay>/client/join
Content-Type: application/json
{ "roomId": "r_…", "joinToken": "…" }

200 { "clientId": "c_…", "clientSession": "<opaque>" }
```

- Ava SHOULD additionally require the browser's signed-in Ava session and
  refuse a room whose owner is not that user (`403 forbidden`). A relay with no
  accounts of its own (on-prem fallback, reference relay) relies on the join
  token alone. Either way the relay is only a gate against noise and abuse:
  without the E2E secrets a joined browser can do nothing (§9).
- `clientId` is chosen by the relay (128 bits, URL-safe) and bound to the
  `clientSession`. The relay MUST stamp it on every frame it forwards from that
  browser, overwriting whatever `cid` the browser wrote.
- A browser keeps its `clientSession` for as long as the tab lives and reuses
  it to reconnect its stream; the same `clientId` lets both ends replay
  unacknowledged frames (§7.4). `POST <relay>/client/leave` ends it.
- `clientSession` expires after 12 h without a stream.

---

## 5. End-to-end handshake

### 5.1 Choice of primitives

Noise Protocol Framework (revision 34), suite **`25519_ChaChaPoly_SHA256`**:

| Primitive | Library (browser and host, same code) | Why |
|---|---|---|
| X25519 | `@noble/curves` 2.4.0 (`ed25519.js` → `x25519`) | audited (Cure53 2022, Kudelski 2023), zero dependencies, pure JS so it runs identically in Node and every browser (WebCrypto X25519 is still missing from some mobile browsers) |
| ChaCha20-Poly1305 | `@noble/ciphers` 2.4.0 (`chacha.js`) | audited (Cure53 2024); constant-time in JS; no WebCrypto ChaCha exists |
| SHA-256, HMAC, HKDF | `@noble/hashes` 2.4.0 | audited (Cure53 2022); WebCrypto has these but is async-only, which would split the Noise state machine across awaits |

Noise rather than an ad-hoc ECDH: its handshake patterns come with published
security properties and test vectors (the implementation is checked against
the cacophony vectors for both patterns used here), and `IK` is the pattern
WireGuard uses. Exact pins are used; versions are bumped deliberately.

Two patterns, both one round trip, both started by the browser (initiator):

| Use | Protocol name | Initiator knows | Proves |
|---|---|---|---|
| First pairing | `Noise_NKpsk0_25519_ChaChaPoly_SHA256` | host static `hk` (from the link) + `psk` | browser holds the pairing secret; host holds `hk`'s private key |
| Every later connection | `Noise_IK_25519_ChaChaPoly_SHA256` | host static `hk` | host holds `hk`'s private key; browser holds a static key on the host's trust list |

**Prologue** (both patterns): the UTF-8 bytes of
`"unieai-remote-control/1\n" + roomId`. A handshake cannot be replayed into
another room.

### 5.2 Pairing (NKpsk0)

```
browser → host   hs1 (mode "pair"):  psk, e, es   + payload P1
host → browser   hs2:                e, ee        + payload P2
```

P1 (encrypted, JSON, UTF-8):
`{"v":1,"s":"<browser static public key>","name":"<device label>"}`

- The browser generates its static X25519 key pair on first use and keeps it
  for this host (§6.3). `s` is what the host will trust.
- `name` is a label the person recognises ("iPhone · Safari"); at most 64
  characters. It is never shown to the relay.

The host, on a valid hs1 (decryption succeeds, so the browser holds `psk`):
1. Consumes the pairing secret (single use) whether or not the rest succeeds.
2. Adds `{deviceId, name, publicKey: s}` to its trust list (§6.2).
3. Answers hs2 with P2: `{"v":1,"deviceId":"d_…","hostName":"…"}`.

A failed hs1 (wrong/expired/consumed psk, malformed) is answered with
`{"t":"err","cid":…,"code":"pair_failed"}` — one code for every cause.
The host allows at most 10 failed handshakes per minute per room.

### 5.3 Reconnecting (IK)

```
browser → host   hs1 (mode "resume"):  e, es, s, ss   + payload R1
host → browser   hs2:                  e, ee, se      + payload R2
```

- R1: `{"v":1}`.
- The host decrypts the initiator's static `s` (step `s`), and continues only
  if `s` is on its trust list; otherwise it answers
  `{"t":"err","cid":…,"code":"unknown_device"}`. A browser that gets
  `unknown_device` has been revoked and must pair again.
- R2: `{"v":1,"deviceId":"d_…","hostName":"…"}`.

### 5.4 Transport keys

`Split()` gives two CipherStates: the first encrypts browser→host, the second
host→browser. Frames carry an **explicit nonce**: the frame's `seq` (§7.2) is
the 64-bit ChaCha20-Poly1305 nonce (Noise's `SetNonce`), associated data is
empty. A receiver MUST reject a frame whose AEAD check fails, and MUST NOT
deliver a `seq` it has already delivered. Each direction stops at
`seq = 2^32` (the host forces a new handshake well before).

### 5.5 Handshake frames

```
{"t":"hs1","cid":"c_…","mode":"pair"|"resume","b":"<handshake message 1>"}
{"t":"hs2","cid":"c_…","b":"<handshake message 2>"}
{"t":"err","cid":"c_…","code":"pair_failed"|"unknown_device"|"busy"|"session_lost"}
```

A new hs1 from a `cid` replaces any session that `cid` had. Sequence numbers
restart at 1 in both directions.

---

## 6. Keys and the trust list

### 6.1 Host key

`$CODEX_HOME/remote-control/host.json` (mode 0600):
`{"hostId":"h_…","privateKey":"…","publicKey":"…","createdAt":"…"}`. Created on
first `start`. Deleting it (or `unieai remote-control reset`, future) makes
every paired browser pair again.

### 6.2 Trust list (host side)

`$CODEX_HOME/remote-control/devices.json` (mode 0600):

```
{"devices":[{"id":"d_…","name":"iPhone · Safari","publicKey":"…",
             "pairedAt":"…","lastSeenAt":"…"}]}
```

- **Only the host decides who is trusted.** The relay cannot add a device:
  adding one requires the pairing secret, which only travels in the fragment.
- `unieai remote-control devices` lists the trust list.
- `unieai remote-control revoke <id>` removes the device and closes its live
  sessions at once; its next IK handshake gets `unknown_device`.
  `revoke --all` empties the list.

### 6.3 Browser side

The browser stores, per host: `{roomId, relay, joinToken, hostKey, hostName,
deviceId, staticPrivateKey, staticPublicKey}`. Ava SHOULD keep the private key
in IndexedDB and never send it anywhere; the reference test page uses
`localStorage`. Losing it means pairing again.

---

## 7. Framing

### 7.1 Frame envelope (visible to the relay)

Every frame is one JSON object:

| Field | Type | Meaning |
|---|---|---|
| `t` | string | frame type, below |
| `cid` | string | the browser this frame is for / from (relay-assigned) |
| `seq` | integer | `d` frames only: per-direction sequence number, from 1 |
| `ack` | integer | `d` and `a` frames: highest contiguous `seq` received from the peer |
| `b` | string | base64url bytes: handshake message or ciphertext |
| `mode`, `code`, `state` | string | as defined per type |

Frame types:

| `t` | Direction | Purpose |
|---|---|---|
| `open` | relay → host | browser `cid` connected (or reconnected) its stream |
| `close` | relay → host | browser `cid` left or its session expired |
| `host` | relay → browser | `state`: `online` / `offline` / `closed` |
| `hs1`, `hs2`, `err` | E2E | handshake (§5.5) |
| `d` | E2E | encrypted data |
| `a` | E2E | bare acknowledgement |
| `reset` | host → browser | the host has no session for this `cid` (it restarted, or the session expired): run IK again |

The relay forwards `hs1`, `hs2`, `err`, `d`, `a`, `reset` without reading or
changing them, except stamping `cid` on frames from a browser. It MUST drop a
host frame whose `cid` is not in the room. It MUST NOT forward a frame larger
than 96 KiB (`413`).

### 7.2 Encrypted payload

`b` of a `d` frame decrypts to UTF-8 JSON, one of:

- `{"m": <JSON-RPC message>}` — a whole message.
- `{"k": {"id": <n>, "i": <index>, "n": <count>}, "p": "<base64url slice>"}` — a
  chunk: slice `i` of `n` of the UTF-8 JSON encoding of one JSON-RPC message
  whose chunk-group id is `id`.

Senders chunk any message whose JSON exceeds **32 KiB**, in slices of 32 KiB.
Chunks of one message are sent consecutively; a receiver keeps one assembly per
direction, discards it when a different `id` arrives before it completes, and
refuses messages over **16 MiB** or **1024** chunks.

### 7.3 Acknowledgement

`ack` is cumulative and end-to-end: "I have decrypted every `seq` up to here
from you". Receivers SHOULD piggyback `ack` on their next `d` frame, and send a
bare `{"t":"a","cid":…,"ack":n}` when nothing else is going out within 250 ms.
The relay MAY read `ack` but MUST NOT generate acknowledgements of its own.

### 7.4 Replay

A sender keeps every `d` frame it sent and the peer has not acknowledged (the
exact frame, same ciphertext — same nonce, same plaintext). After any
reconnect — the host receives `open` for a `cid` it has a session with, or a
browser's stream comes back — the sender re-sends every unacknowledged frame,
in order. The receiver delivers `seq == lastDelivered + 1`, ignores
`seq ≤ lastDelivered`, and drops (without delivering) anything later, which the
sender's next replay fills in.

Bounds: 4096 frames or 32 MiB per direction per session. A host whose buffer
overflows drops the session and sends `reset`; the browser re-handshakes and
re-reads the thread (`thread/read`), which is always a complete picture.

A host keeps a session whose browser has gone for **15 minutes**; after that a
returning `d` frame gets `reset`.

### 7.5 Liveness

The relay's `: ping` comments keep streams alive (§2.1). The host learns of a
departed browser from `close`; the browser learns of the host from `host`
frames. No E2E ping is needed.

---

## 8. What a browser may do

Inside the channel both sides speak JSON-RPC 2.0 with the app-server v2
shapes (the `jsonrpc` member MAY be omitted, as the app-server does). The host
enforces this whitelist **after decryption**; anything else is answered with
error `-32601 "<method> is not available to remote clients"`.

### 8.1 Browser → host requests

| Method | Params accepted (everything else is dropped) | Notes |
|---|---|---|
| `initialize` | — | answered by the bridge: `{hostName, version, deviceId, methods}` |
| `thread/list` | `limit`, `cursor`, `searchTerm`, `archived`, `sortKey`, `sortDirection` | |
| `thread/read` | `threadId`, `includeTurns` | also **attaches** the browser to the thread: from now on it gets the thread's notifications and server requests |
| `thread/unsubscribe` | `threadId` | detaches the browser only; never unloads the thread |
| `turn/start` | `threadId`, `input`, `clientUserMessageId` | `input` items: `{"type":"text","text"}` and `{"type":"image","url":"data:…"}` only |
| `turn/steer` | `threadId`, `input`, `expectedTurnId`, `clientUserMessageId` | same `input` rule |
| `turn/interrupt` | `threadId`, `turnId` | |

Deliberately **not** available remotely, whatever the params: `config/*`,
`fs/*`, `command/exec`, `account/*`, `login/*` and every other platform method;
`thread/start`, `thread/resume`, `thread/fork`, `thread/settings/update` (they
carry sandbox and approval settings — a remote must not be able to widen the
session's permissions); `thread/shellCommand` (runs a command with no approval);
`thread/revert`, `thread/delete`, `thread/archive`, goals, `review/start`.

`turn/start` is rebuilt from the accepted fields, so a remote cannot pass
`sandboxPolicy`, `approvalPolicy`, `permissions`, `model`, `cwd` or
`outputSchema`. A `localImage` input (a path on the host) is refused.

### 8.2 Host → browser

- **Notifications** for every thread the browser is attached to: the same
  stream a TUI gets (`turn/started`, `item/started`, `item/agentMessage/delta`,
  `item/completed`, `turn/completed`, `thread/status/changed`,
  `serverRequest/resolved`, …).
- **Server requests** for attached threads, answered by the browser:
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`. Ids are negative integers, unique per browser
  session.
- Never `item/tool/call`: client tools run in the TUI that owns the thread.

### 8.3 Answering server requests

The browser answers with a JSON-RPC response carrying the request's `id`. The
bridge accepts only a response to a request it sent that browser and that is
still pending, and only these results:

| Request | Result |
|---|---|
| approvals | `{"decision": "accept" \| "acceptForSession" \| "decline" \| "cancel"}` |
| `item/tool/requestUserInput` | `{"answers": {"<questionId>": {"answers": ["<label or user_note: text>", …]}}}` |

### 8.4 Many clients, one session

Each thread has one **driver** — the TUI that started (or, once that TUI is
gone, resumed) it, which hosts the thread's client tools — and any number of
**subscribers** (other TUIs, remote browsers):

- Notifications go to all of them.
- Approval and question requests go to all of them; **the first answer wins**.
  Every client that was asked then gets
  `serverRequest/resolved {"threadId", "requestId"}` (with its own request id),
  and a TUI dismisses its prompt. A client that attaches while a request is
  pending is sent that request too.
- A client that disconnects or errors does not answer; if nobody is left to
  ask, the request fails closed (declined).
- `turn/start`, `turn/steer` and `turn/interrupt` are accepted from any
  subscriber.
- Client tools (`item/tool/call`) go only to the driver. A remote never becomes
  the driver.

---

## 9. What the relay can and cannot see

**Can see (routing metadata):**

- the owner's identity (from the host credential, and from the Ava session
  when it requires one), the host's `hostId`, `hostName`, platform and version;
- `roomId`, `joinToken`, each browser's `clientId`, IP addresses, user agents;
- when hosts and browsers connect, and how many browsers are in a room;
- each frame's type, size and timing, `seq` / `ack` numbers, and whether a
  handshake is a pairing (`mode:"pair"`) or a reconnect, and its error code.

**Cannot see:**

- anything inside `b`: prompts, model output, file contents, commands,
  approval requests and decisions, questions and answers, thread ids, thread
  titles, which methods are called;
- the pairing secret, the host's static public or private key, a browser's
  static keys, device ids and names, the trust list.

**Cannot do:** pair a device (needs `psk`), impersonate the host (needs the
host's private key), impersonate a paired browser (needs its private key), or
inject or alter a message (AEAD). It **can** drop, delay or replay frames
(replays are discarded by `seq`), and deny service.

**Honest limit:** E2E protects against the relay, the network and a database
leak — not against whoever serves the browser's JavaScript. A web server that
serves malicious page code can read the fragment. Ava's remote page SHOULD be a
static bundle with a strict CSP and no third-party scripts; on-prem users can
serve the reference page from their own relay.

---

## 10. Host control methods (local only)

The TUI and `unieai remote-control` drive the bridge over the uac server's
local socket (never over the relay):

| Method | Params | Result |
|---|---|---|
| `unieai/remote/start` | `relayUrl?`, `webUrl?` | `{running, relayUrl, roomId, link, expiresAt, viewers, devices}` (a fresh pairing link) |
| `unieai/remote/stop` | — | `{running:false}` |
| `unieai/remote/status` | — | `{running, connected, relayUrl, roomId, viewers, devices, error}` |
| `unieai/remote/devices` | — | `{devices:[{id,name,pairedAt,lastSeenAt,online}]}` |
| `unieai/remote/revoke` | `deviceId` or `all:true` | `{revoked:[ids]}` |

`viewers` is the number of browsers with an established E2E session.

---

## 11. Checklist for a relay implementation

1. `POST /host/register`: validate the credential per §3.1 against the origin
   allowlist; derive the owner; return a stable `roomId` per `(owner, hostId)`,
   a `hostSession` (≤ 12 h), a `joinToken`, `webUrl`.
2. `GET /host/stream` (SSE): one per room, newest wins; `: ping` every 15 s;
   on open send `open` for each connected browser and `host:online` to browsers.
3. `POST /host/send`: forward each frame to its `cid`'s stream (drop unknown
   `cid`s and list them in `dropped`); ≤ 64 frames, ≤ 96 KiB per frame.
4. `POST /host/unregister`: close the room's streams, `host:closed` to browsers.
5. `POST /client/join`: check `joinToken` (Ava: and the signed-in user owns the
   room); assign `clientId`; return `clientSession`. ≤ 16 clients per room.
6. `GET /client/stream` (SSE): send `host` state first; tell the host `open`.
7. `POST /client/send`: stamp `cid`, forward to the host stream; if the host is
   offline, answer `200 {"ok":true,"queued":false}` and drop (browsers replay).
8. `POST /client/leave`, stream timeouts: tell the host `close`.
9. Never log or store `b`; never generate `ack`s; rate-limit `hs1` frames per
   room (10/min suggested) and joins per IP.

## 12. Checklist for a browser implementation

1. Parse the fragment, clear it with `history.replaceState`, store the host
   record (§6.3) once pairing succeeds.
2. `POST /client/join`, open `/client/stream` with `fetch`, handle `host`
   frames.
3. New device: NKpsk0 with `hk`, `psk`, prologue; P1 carries the static public
   key and a device name. Known device: IK with the stored static key.
4. Encrypt/decrypt `d` frames with explicit nonces = `seq`; ack; keep a replay
   buffer; replay after every reconnect; on `reset` run IK again and re-read.
5. `initialize`, `thread/list`, `thread/read` (attach), render the v2 item
   stream; `turn/start` / `turn/steer` / `turn/interrupt` from the composer.
6. Render `item/commandExecution/requestApproval`,
   `item/fileChange/requestApproval` and `item/tool/requestUserInput`; answer
   with the decisions in §8.3; dismiss on `serverRequest/resolved` or
   `turn/completed`.
7. On `err unknown_device`, forget the host record and ask the person to pair
   again.

## 13. Versioning

`protocol: 1` at registration, `v:1` in the fragment and in every handshake
payload. A breaking change bumps all three; a host refuses a handshake payload
with an unknown `v`.
