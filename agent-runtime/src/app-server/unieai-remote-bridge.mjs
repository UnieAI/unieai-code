// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-bridge.mjs — Remote Control's host side: browsers watch,
 * steer, approve and answer this machine's uac sessions through a relay that
 * only ever carries ciphertext.
 *
 * docs/unieai/remote-control-protocol.md is the contract; section numbers
 * below refer to it. The bridge lives in the uac server process and is an
 * in-process client of it: each browser is one more client `ctx` of the
 * server's handlers, a subscriber that never drives a thread
 * (unieai-thread-clients.mjs), so notifications, approvals and questions
 * reach it exactly as they reach a TUI.
 *
 *   relay link   register with the user's UnieAI sign-in (§3), keep the
 *                host stream open (SSE down, POST up) and reconnect with
 *                backoff (§2.4)
 *   handshakes   Noise NKpsk0 to pair a browser, IK to reconnect one (§5),
 *                against the host key and trust list kept in
 *                $CODEX_HOME/remote-control (§6)
 *   sessions     one encrypted channel per browser (unieai-remote-channel.mjs),
 *                replayed after a reconnect (§7.4)
 *   whitelist    a browser may read threads, start, steer and interrupt
 *                turns, and answer the approvals and questions it was asked
 *                (§8); nothing that changes settings, touches files or runs a
 *                command directly
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { createChannel } from "./unieai-remote-channel.mjs";
import {
  PAIR_PROTOCOL,
  RESUME_PROTOCOL,
  createHandshake,
  fromBase64Url,
  generateKeyPair,
  prologueFor,
  randomBytes,
  toBase64Url,
} from "./unieai-remote-noise.mjs";

export const DEFAULT_RELAY_URL = "https://agent.unieai.com/api/remote";
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** How long a browser that went away keeps its session (§7.4). */
export const SESSION_GRACE_MS = 15 * 60 * 1000;
const STREAM_IDLE_MS = 45_000;
const BACKOFF_MAX_MS = 30_000;
const HANDSHAKE_FAILURES_PER_MINUTE = 10;
const SEND_BATCH = 64;

/** The methods a browser may call (§8.1). */
export const REMOTE_METHODS = [
  "initialize",
  "thread/list",
  "thread/read",
  "thread/unsubscribe",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];

/** The requests a browser may be asked, and so may answer (§8.2, §8.3). */
const ANSWERABLE = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
]);
const DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

const pick = (source, keys) =>
  Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));

/**
 * A turn's input as a remote may give it: text, and images inline as data
 * URLs. A `localImage` names a file on this machine, which a remote has no
 * business reading through the model.
 */
export function remoteInput(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (!Array.isArray(input)) throw new RemoteError(-32602, "input must be a list of text and image items");
  return input.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "image" && typeof part.url === "string" && part.url.startsWith("data:image/")) return { type: "image", url: part.url };
    throw new RemoteError(-32602, `input items must be text or inline images, not ${part?.type ?? typeof part}`);
  });
}

/** A browser's answer, reduced to what its request allows (§8.3). */
export function remoteAnswer(method, result) {
  if (method === "item/tool/requestUserInput") {
    const answers = {};
    for (const [id, entry] of Object.entries(result?.answers ?? {})) {
      const list = Array.isArray(entry?.answers) ? entry.answers.filter((answer) => typeof answer === "string") : [];
      answers[id] = { answers: list };
    }
    return { answers };
  }
  const decision = typeof result?.decision === "string" && DECISIONS.has(result.decision) ? result.decision : "decline";
  return { decision };
}

class RemoteError extends Error {
  constructor(code, message) {
    super(message);
    this.rpcCode = code;
  }
}

// --- Files under $CODEX_HOME/remote-control (§6) ------------------------------

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writePrivateJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function remoteControlStore(codexHome) {
  const dir = join(codexHome, "remote-control");
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {}
  };
  const hostPath = join(dir, "host.json");
  const devicesPath = join(dir, "devices.json");
  const settingsPath = join(dir, "settings.json");
  return {
    dir,
    /** The host's static key and id, made on first use. */
    hostKey() {
      const stored = readJson(hostPath, null);
      if (stored?.privateKey && stored?.hostId) {
        const pair = generateKeyPair(fromBase64Url(stored.privateKey));
        return { hostId: stored.hostId, ...pair };
      }
      ensureDir();
      const pair = generateKeyPair();
      const hostId = `h_${toBase64Url(randomBytes(16))}`;
      writePrivateJson(hostPath, {
        hostId,
        privateKey: toBase64Url(pair.privateKey),
        publicKey: toBase64Url(pair.publicKey),
        createdAt: new Date().toISOString(),
      });
      return { hostId, ...pair };
    },
    devices: () => readJson(devicesPath, { devices: [] }).devices ?? [],
    saveDevices(devices) {
      ensureDir();
      writePrivateJson(devicesPath, { devices });
    },
    settings: () => readJson(settingsPath, {}),
  };
}

/** The user's UnieAI sign-in, as the relay authenticates a host (§3.1). */
export function hostCredential(codexHome) {
  const stored = readJson(join(codexHome, "unieai.json"), null);
  if (!stored?.access_token || !stored?.studio_url) return null;
  return {
    account: stored.account === "rabi" ? "rabi" : "studio",
    token: stored.access_token,
    origin: String(stored.studio_url).replace(/\/+$/, ""),
  };
}

/**
 * Where the relay is (§2): an explicit choice, then UNIEAI_REMOTE_RELAY_URL,
 * then settings.json, then Ava.
 */
export function resolveRelayUrl({ requested = null, env = process.env, settings = {} } = {}) {
  const url = requested || env.UNIEAI_REMOTE_RELAY_URL || settings.relayUrl || DEFAULT_RELAY_URL;
  return String(url).replace(/\/+$/, "");
}

/** The pairing link (§4.1): everything secret is in the fragment. */
export function pairingLink({ webUrl, relayUrl, roomId, joinToken, hostKey, psk, hostName }) {
  const fragment = new URLSearchParams({
    v: "1",
    relay: relayUrl,
    room: roomId,
    join: joinToken,
    hk: toBase64Url(hostKey),
    psk: toBase64Url(psk),
    name: hostName,
  });
  return `${String(webUrl).split("#")[0]}#${fragment.toString()}`;
}

// --- The relay link: SSE down, POST up (§2) -------------------------------------

/** Read an SSE response body, calling `onFrame` for each `data:` line. */
async function readEventStream(body, { onFrame, onBytes }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onBytes();
    carry += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = carry.indexOf("\n")) >= 0) {
      const line = carry.slice(0, newline).replace(/\r$/, "");
      carry = carry.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      try {
        onFrame(JSON.parse(line.slice(5).trim()));
      } catch {
        // A frame that does not parse is the relay's mistake; skip it.
      }
    }
  }
}

/**
 * Build the bridge over the server's `handlers` (createHandlers).
 *
 * `fetch`, `now`, `random` and `log` are injectable for tests.
 */
export function createRemoteBridge({
  handlers,
  codexHome,
  version = "0.0.0",
  hostName = hostname(),
  fetch: fetchImpl = globalThis.fetch,
  env = process.env,
  log = () => {},
  now = () => Date.now(),
}) {
  const store = remoteControlStore(codexHome);
  const sessions = new Map(); // cid -> session
  const handshakeFailures = []; // timestamps, for §5.2's rate limit
  let link = null; // the current relay link, while started
  let pairing = null; // { psk, expiresAt }

  // --- Relay link ---------------------------------------------------------

  const startLink = ({ relayUrl, webUrl }) => {
    const state = {
      relayUrl,
      webUrlOverride: webUrl,
      registration: null,
      connected: false,
      stopped: false,
      error: null,
      abort: null,
      outbox: [],
      sending: false,
      ready: null,
    };
    let resolveReady;
    let rejectReady;
    state.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    state.ready.catch(() => {});

    const register = async () => {
      const credential = hostCredential(codexHome);
      if (!credential) throw Object.assign(new Error("sign in to UnieAI first (unieai login)"), { permanent: true });
      const key = store.hostKey();
      const response = await fetchImpl(`${relayUrl}/host/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.token}`,
          "x-unieai-account": credential.account,
          "x-unieai-origin": credential.origin,
        },
        body: JSON.stringify({ protocol: 1, hostId: key.hostId, hostName, platform: platform(), version }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message = body?.error?.message || `the relay answered ${response.status}`;
        throw Object.assign(new Error(message), { permanent: response.status === 401 || response.status === 403 });
      }
      const registration = await response.json();
      if (!registration?.roomId || !registration?.hostSession) throw new Error("the relay's registration answer is incomplete");
      return registration;
    };

    const postFrames = async () => {
      if (state.sending || state.stopped) return;
      state.sending = true;
      try {
        while (state.outbox.length && !state.stopped && state.registration) {
          const batch = state.outbox.slice(0, SEND_BATCH);
          let response;
          try {
            response = await fetchImpl(`${relayUrl}/host/send`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${state.registration.hostSession}` },
              body: JSON.stringify({ frames: batch }),
            });
          } catch (error) {
            // The stream's reconnect replays what the browser did not
            // acknowledge; frames that were not E2E data are best effort.
            log(`[remote] send failed: ${error.message}`);
            state.outbox.length = 0;
            break;
          }
          state.outbox.splice(0, batch.length);
          if (!response.ok) log(`[remote] the relay refused ${batch.length} frame(s): ${response.status}`);
        }
      } finally {
        state.sending = false;
      }
    };

    state.send = (frame) => {
      if (state.stopped) return;
      state.outbox.push(frame);
      queueMicrotask(postFrames);
    };

    const run = async () => {
      let delay = 1000;
      for (;;) {
        if (state.stopped) return;
        let openedAt = null;
        try {
          if (!state.registration) {
            state.registration = await register();
            state.error = null;
            resolveReady(state.registration);
          }
          const abort = new AbortController();
          state.abort = abort;
          const response = await fetchImpl(`${relayUrl}/host/stream`, {
            headers: { authorization: `Bearer ${state.registration.hostSession}`, accept: "text/event-stream" },
            signal: abort.signal,
          });
          if (response.status === 401) {
            // The host session expired: register again.
            state.registration = null;
            continue;
          }
          if (!response.ok || !response.body) throw new Error(`the relay's stream answered ${response.status}`);
          state.connected = true;
          openedAt = now();
          log(`[remote] connected to ${relayUrl} (room ${state.registration.roomId})`);
          // Silence for too long means the stream is dead (§2.1).
          let lastBytes = now();
          const watchdog = setInterval(() => {
            if (now() - lastBytes > STREAM_IDLE_MS) abort.abort();
          }, 5_000);
          watchdog.unref?.();
          try {
            await readEventStream(response.body, { onFrame, onBytes: () => (lastBytes = now()) });
          } finally {
            clearInterval(watchdog);
          }
        } catch (error) {
          if (state.stopped) return;
          state.error = error.message;
          if (error.permanent) {
            log(`[remote] ${error.message}`);
            rejectReady(error);
            state.stopped = true;
            return;
          }
          log(`[remote] relay link: ${error.message}`);
        } finally {
          state.connected = false;
          state.abort = null;
        }
        if (state.stopped) return;
        if (openedAt !== null && now() - openedAt > 60_000) delay = 1000;
        const jitter = delay * (0.8 + Math.random() * 0.4);
        await new Promise((resolve) => setTimeout(resolve, jitter).unref?.());
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    };

    state.stop = async () => {
      state.stopped = true;
      state.abort?.abort();
      rejectReady(new Error("stopped"));
      if (state.registration) {
        await fetchImpl(`${relayUrl}/host/unregister`, {
          method: "POST",
          headers: { authorization: `Bearer ${state.registration.hostSession}` },
        }).catch(() => {});
      }
    };

    run();
    return state;
  };

  // --- Frames from the relay (§7.1) ----------------------------------------

  const sendFrame = (frame) => link?.send(frame);

  const onFrame = (frame) => {
    if (!frame || typeof frame !== "object" || typeof frame.t !== "string") return;
    const cid = typeof frame.cid === "string" ? frame.cid : null;
    switch (frame.t) {
      case "open": {
        const session = cid && sessions.get(cid);
        if (session) {
          session.connected = true;
          session.awaySince = null;
          session.channel.replay();
        }
        return;
      }
      case "close": {
        const session = cid && sessions.get(cid);
        if (session) {
          session.connected = false;
          session.awaySince = now();
        }
        return;
      }
      case "hs1":
        if (cid) onHandshake(cid, frame);
        return;
      case "d":
      case "a": {
        const session = cid && sessions.get(cid);
        if (!session) {
          if (cid && frame.t === "d") sendFrame({ t: "reset", cid });
          return;
        }
        session.lastSeenAt = now();
        session.channel.receive(frame);
        return;
      }
      default:
    }
  };

  const handshakeAllowed = () => {
    const cutoff = now() - 60_000;
    while (handshakeFailures.length && handshakeFailures[0] < cutoff) handshakeFailures.shift();
    return handshakeFailures.length < HANDSHAKE_FAILURES_PER_MINUTE;
  };

  const onHandshake = (cid, frame) => {
    const roomId = link?.registration?.roomId;
    if (!roomId) return;
    const fail = (code, why) => {
      handshakeFailures.push(now());
      log(`[remote] handshake from ${cid} refused: ${why}`);
      sendFrame({ t: "err", cid, code });
    };
    if (!handshakeAllowed()) return sendFrame({ t: "err", cid, code: "busy" });
    const key = store.hostKey();
    const prologue = prologueFor(roomId);
    let message;
    try {
      message = fromBase64Url(frame.b ?? "");
    } catch {
      return fail(frame.mode === "pair" ? "pair_failed" : "unknown_device", "malformed");
    }

    if (frame.mode === "pair") {
      const offer = pairing;
      if (!offer || offer.expiresAt < now()) return fail("pair_failed", "no pairing is open");
      let handshake;
      let hello;
      try {
        handshake = createHandshake({ protocol: PAIR_PROTOCOL, initiator: false, prologue, s: key, psk: offer.psk });
        hello = JSON.parse(new TextDecoder().decode(handshake.readMessage(message)));
      } catch {
        return fail("pair_failed", "wrong or expired pairing secret");
      }
      // Single use: a browser that proved it holds the secret spends it,
      // whatever happens next (§5.2).
      pairing = null;
      let publicKey;
      try {
        publicKey = fromBase64Url(hello?.s ?? "");
      } catch {
        publicKey = null;
      }
      if (hello?.v !== 1 || publicKey?.length !== 32) return fail("pair_failed", "malformed pairing payload");
      const devices = store.devices();
      const encoded = toBase64Url(publicKey);
      let device = devices.find((entry) => entry.publicKey === encoded);
      if (!device) {
        device = {
          id: `d_${toBase64Url(randomBytes(9))}`,
          name: String(hello.name ?? "browser").slice(0, 64),
          publicKey: encoded,
          pairedAt: new Date(now()).toISOString(),
          lastSeenAt: new Date(now()).toISOString(),
        };
        devices.push(device);
        store.saveDevices(devices);
      }
      log(`[remote] paired ${device.name} (${device.id})`);
      return establish(cid, handshake, device);
    }

    if (frame.mode === "resume") {
      let handshake;
      try {
        handshake = createHandshake({ protocol: RESUME_PROTOCOL, initiator: false, prologue, s: key });
        handshake.readMessage(message);
      } catch {
        return fail("unknown_device", "the handshake did not verify");
      }
      const encoded = toBase64Url(handshake.remoteStatic);
      const devices = store.devices();
      const device = devices.find((entry) => entry.publicKey === encoded);
      if (!device) return fail("unknown_device", "not on the trust list");
      device.lastSeenAt = new Date(now()).toISOString();
      store.saveDevices(devices);
      return establish(cid, handshake, device);
    }
    fail("pair_failed", `unknown mode ${frame.mode}`);
  };

  /** Answer the handshake and open the session (§5.4). */
  const establish = (cid, handshake, device) => {
    dropSession(cid);
    const reply = handshake.writeMessage(new TextEncoder().encode(JSON.stringify({ v: 1, deviceId: device.id, hostName })));
    const cipher = handshake.split();
    sendFrame({ t: "hs2", cid, b: toBase64Url(reply) });
    const session = {
      cid,
      device,
      connected: true,
      awaySince: null,
      lastSeenAt: now(),
      pending: new Map(), // our request id -> { method, resolve, reject }
      nextId: -1,
      ctx: null,
      channel: null,
    };
    session.channel = createChannel({
      cipher,
      cid,
      sendFrame,
      onMessage: (message) => onRemoteMessage(session, message),
      onError: (error) => log(`[remote] ${device.name}: ${error.message}`),
      onOverflow: () => {
        log(`[remote] ${device.name} was away too long; resetting its session`);
        dropSession(cid);
        sendFrame({ t: "reset", cid });
      },
    });
    session.ctx = remoteClient(session);
    sessions.set(cid, session);
  };

  const dropSession = (cid) => {
    const session = sessions.get(cid);
    if (!session) return;
    sessions.delete(cid);
    session.ctx.closed = true;
    handlers._detach(session.ctx);
    session.channel.close();
    for (const { reject } of session.pending.values()) reject(new Error("the remote session ended"));
    session.pending.clear();
  };

  // Sessions whose browser never came back (§7.4).
  const sweeper = setInterval(() => {
    for (const [cid, session] of sessions) {
      if (session.awaySince !== null && now() - session.awaySince > SESSION_GRACE_MS) dropSession(cid);
    }
  }, 60_000);
  sweeper.unref?.();

  /**
   * The browser as a client of the server: a subscriber that never drives,
   * asked only what a remote may answer (§8.2).
   */
  const remoteClient = (session) => {
    const ctx = {
      remote: true,
      closed: false,
      emit: (method, params) => session.channel.send({ method, params }),
      request: (method, params, { timeoutMs = 0, signal = null, onId = null } = {}) =>
        new Promise((resolve, reject) => {
          if (!ANSWERABLE.has(method)) return reject(new Error(`${method} is not asked of remote clients`));
          if (ctx.closed) return reject(new Error("the remote session ended"));
          const id = session.nextId--;
          const timer = timeoutMs > 0
            ? setTimeout(() => {
                session.pending.delete(id);
                resolve({ decision: "decline" });
              }, timeoutMs)
            : null;
          timer?.unref?.();
          session.pending.set(id, {
            method,
            resolve: (value) => {
              if (timer) clearTimeout(timer);
              resolve(value);
            },
            reject: (error) => {
              if (timer) clearTimeout(timer);
              reject(error);
            },
          });
          signal?.addEventListener("abort", () => {
            const entry = session.pending.get(id);
            if (!entry) return;
            session.pending.delete(id);
            entry.reject(new Error("answered by another client"));
          }, { once: true });
          onId?.(id);
          session.channel.send({ id, method, params });
        }),
    };
    return ctx;
  };

  // --- What a browser may call (§8) ------------------------------------------

  const remoteHandlers = {
    async initialize(session) {
      return { hostName, version, deviceId: session.device.id, methods: REMOTE_METHODS };
    },
    async "thread/list"(session, params) {
      if (typeof handlers["thread/list"] !== "function") throw new RemoteError(-32601, "this host keeps no thread list");
      return handlers["thread/list"](pick(params, ["limit", "cursor", "searchTerm", "archived", "sortKey", "sortDirection"]));
    },
    async "thread/read"(session, params) {
      const threadId = params?.threadId;
      const read = await handlers["thread/read"]({ threadId, includeTurns: Boolean(params?.includeTurns) }, session.ctx);
      // Reading a thread is watching it: from now on its stream reaches
      // this browser. A subagent's thread is shown through its root's.
      try {
        handlers._attach(threadId, session.ctx);
      } catch {}
      return read;
    },
    async "thread/unsubscribe"(session, params) {
      handlers._detach(session.ctx, params?.threadId ?? null);
      return { status: "unsubscribed" };
    },
    async "turn/start"(session, params) {
      // Rebuilt from the accepted fields: no sandbox, approval, model or cwd
      // from a remote (§8.1).
      const clean = { threadId: params?.threadId, input: remoteInput(params?.input), ...pick(params, ["clientUserMessageId"]) };
      return handlers["turn/start"](clean, session.ctx);
    },
    async "turn/steer"(session, params) {
      const clean = { threadId: params?.threadId, input: remoteInput(params?.input), ...pick(params, ["expectedTurnId", "clientUserMessageId"]) };
      return handlers["turn/steer"](clean, session.ctx);
    },
    async "turn/interrupt"(session, params) {
      return handlers["turn/interrupt"](pick(params, ["threadId", "turnId"]), session.ctx);
    },
  };

  const onRemoteMessage = async (session, message) => {
    if (!message || typeof message !== "object") return;
    // An answer to something we asked (§8.3).
    if (!message.method && message.id !== undefined) {
      const entry = session.pending.get(message.id);
      if (!entry) return;
      session.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "the remote refused"));
      else entry.resolve(remoteAnswer(entry.method, message.result));
      return;
    }
    if (typeof message.method !== "string" || message.id === undefined || message.id === null) return;
    const handler = Object.hasOwn(remoteHandlers, message.method) ? remoteHandlers[message.method] : null;
    if (!handler) {
      session.channel.send({ id: message.id, error: { code: -32601, message: `${message.method} is not available to remote clients` } });
      return;
    }
    try {
      const result = await handler(session, message.params ?? {});
      session.channel.send({ id: message.id, result: result ?? null });
    } catch (error) {
      const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603;
      session.channel.send({ id: message.id, error: { code, message: String(error?.message || error) } });
    }
  };

  // --- Local control (§10) ---------------------------------------------------

  const viewers = () => [...sessions.values()].filter((session) => session.connected).length;

  const status = () => ({
    running: Boolean(link && !link.stopped),
    connected: Boolean(link?.connected),
    relayUrl: link?.relayUrl ?? resolveRelayUrl({ env, settings: store.settings() }),
    roomId: link?.registration?.roomId ?? null,
    viewers: viewers(),
    devices: store.devices().length,
    error: link?.error ?? null,
  });

  return {
    /** Start (or keep) the relay link and open a fresh pairing link. */
    async start({ relayUrl = null, webUrl = null } = {}) {
      const settings = store.settings();
      const relay = resolveRelayUrl({ requested: relayUrl, env, settings });
      if (link && (link.stopped || link.relayUrl !== relay)) {
        await this.stop();
      }
      if (!link) link = startLink({ relayUrl: relay, webUrl });
      const registration = await link.ready;
      const key = store.hostKey();
      pairing = { psk: randomBytes(32), expiresAt: now() + PAIRING_TTL_MS };
      const web = webUrl || env.UNIEAI_REMOTE_WEB_URL || settings.webUrl || registration.webUrl;
      if (!web) throw new Error("the relay did not say where its web page is; set UNIEAI_REMOTE_WEB_URL");
      return {
        ...status(),
        link: pairingLink({
          webUrl: web,
          relayUrl: relay,
          roomId: registration.roomId,
          joinToken: registration.joinToken,
          hostKey: key.publicKey,
          psk: pairing.psk,
          hostName,
        }),
        expiresAt: new Date(pairing.expiresAt).toISOString(),
      };
    },

    async stop() {
      const current = link;
      link = null;
      pairing = null;
      for (const cid of [...sessions.keys()]) dropSession(cid);
      await current?.stop();
      return { running: false };
    },

    status,

    devices() {
      const online = new Set([...sessions.values()].filter((session) => session.connected).map((session) => session.device.id));
      return {
        devices: store.devices().map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt, online: online.has(id) })),
      };
    },

    /** Remove devices from the trust list and end their live sessions (§6.2). */
    revoke({ deviceId = null, all = false } = {}) {
      const devices = store.devices();
      const revoked = devices.filter((device) => all || device.id === deviceId).map((device) => device.id);
      if (!revoked.length) throw new Error(deviceId ? `no paired device ${deviceId}` : "no paired devices");
      store.saveDevices(devices.filter((device) => !revoked.includes(device.id)));
      for (const [cid, session] of sessions) {
        if (revoked.includes(session.device.id)) {
          dropSession(cid);
          sendFrame({ t: "err", cid, code: "unknown_device" });
        }
      }
      return { revoked };
    },

    async close() {
      clearInterval(sweeper);
      await this.stop();
    },

    /** For tests. */
    _sessions: sessions,
  };
}
