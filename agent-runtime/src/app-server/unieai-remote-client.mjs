// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-client.mjs — the browser side of Remote Control.
 *
 * docs/unieai/remote-control-protocol.md §4, §5, §7 and §12, as one object:
 * join the room at the relay, keep the client stream open, pair (Noise
 * NKpsk0) or reconnect (IK) with the host, then exchange JSON-RPC through the
 * encrypted channel. The reference relay's test page uses it in the browser
 * and the end-to-end test drives it from Node, so it uses nothing but
 * `fetch`, timers and the shared protocol modules. Ava's UI may use it as is
 * or reimplement it from the spec.
 */
import { createChannel } from "./unieai-remote-channel.mjs";
import {
  PAIR_PROTOCOL,
  RESUME_PROTOCOL,
  createHandshake,
  fromBase64Url,
  generateKeyPair,
  prologueFor,
  toBase64Url,
} from "./unieai-remote-noise.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The host record a pairing link carries (§4.1). `relay` defaults to the
 * page origin's `/api/remote`.
 */
export function parsePairingLink(link) {
  const url = new URL(link);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (fragment.get("v") !== "1") throw new Error("this is not a UnieAI Remote Control link (or it is a newer version)");
  const required = (name) => {
    const value = fragment.get(name);
    if (!value) throw new Error(`the link has no ${name}`);
    return value;
  };
  return {
    relayUrl: (fragment.get("relay") || `${url.origin}/api/remote`).replace(/\/+$/, ""),
    roomId: required("room"),
    joinToken: required("join"),
    hostKey: required("hk"),
    psk: required("psk"),
    hostName: fragment.get("name") || "",
  };
}

/**
 * A remote client for one host.
 *
 *   host           { relayUrl, roomId, joinToken, hostKey, hostName } (base64url keys)
 *   psk            the pairing secret (first visit only)
 *   device         { privateKey, publicKey, deviceId } once paired
 *   deviceName     the label the host lists this device under
 *   onNotification(method, params)
 *   onRequest(method, params) -> result   approvals and questions
 *   onPaired(device)                      store it: the next visit needs it
 *   onState(state, detail)                "connecting" | "ready" | "host-offline" | "reset" | "error" | "closed"
 */
export function createRemoteClient({
  host,
  psk = null,
  device = null,
  deviceName = "browser",
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  onNotification = () => {},
  onRequest = async () => ({ decision: "decline" }),
  onPaired = () => {},
  onState = () => {},
  log = () => {},
}) {
  const relay = host.relayUrl.replace(/\/+$/, "");
  let join = null; // { clientId, clientSession }
  let channel = null;
  let handshake = null; // { state, mode }
  let hostOnline = false;
  let closed = false;
  let streamAbort = null;
  let nextId = 1;
  const pending = new Map();
  const outbox = [];
  let sending = false;
  let ready;
  let readyResolve;
  let readyReject;
  const resetReady = () => {
    ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    ready.catch(() => {});
  };
  resetReady();

  const post = async (path, body) => {
    const response = await fetchImpl(`${relay}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(join ? { authorization: `Bearer ${join.clientSession}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(answer?.error?.message || `the relay answered ${response.status}`), { status: response.status });
    return answer;
  };

  const flush = async () => {
    if (sending) return;
    sending = true;
    try {
      while (outbox.length && !closed) {
        const frames = outbox.splice(0, 64);
        // Lost sends are recovered by replay after the stream reconnects.
        await post("/client/send", { frames }).catch((error) => log(`send failed: ${error.message}`));
      }
    } finally {
      sending = false;
    }
  };
  const sendFrame = (frame) => {
    outbox.push(frame);
    queueMicrotask(flush);
  };

  const startHandshake = () => {
    if (handshake || channel || closed || !hostOnline) return;
    const prologue = prologueFor(host.roomId);
    const rs = fromBase64Url(host.hostKey);
    if (device?.deviceId) {
      const s = generateKeyPair(fromBase64Url(device.privateKey));
      const state = createHandshake({ protocol: RESUME_PROTOCOL, initiator: true, prologue, s, rs });
      handshake = { state, mode: "resume" };
      sendFrame({ t: "hs1", mode: "resume", b: toBase64Url(state.writeMessage(encoder.encode(JSON.stringify({ v: 1 })))) });
      return;
    }
    if (!psk) {
      readyReject(new Error("this device is not paired with the host; open a new pairing link"));
      onState("error", "not paired");
      return;
    }
    const keys = generateKeyPair();
    device = { privateKey: toBase64Url(keys.privateKey), publicKey: toBase64Url(keys.publicKey), deviceId: null };
    const state = createHandshake({ protocol: PAIR_PROTOCOL, initiator: true, prologue, rs, psk: fromBase64Url(psk) });
    const hello = { v: 1, s: device.publicKey, name: deviceName };
    handshake = { state, mode: "pair" };
    sendFrame({ t: "hs1", mode: "pair", b: toBase64Url(state.writeMessage(encoder.encode(JSON.stringify(hello)))) });
  };

  const onHandshakeReply = (frame) => {
    if (!handshake) return;
    const { state, mode } = handshake;
    handshake = null;
    let payload;
    try {
      payload = JSON.parse(decoder.decode(state.readMessage(fromBase64Url(frame.b))));
    } catch (error) {
      // Only the host's key could have answered: someone else did.
      readyReject(new Error("the host's answer did not verify"));
      onState("error", "the host's answer did not verify");
      return;
    }
    if (mode === "pair") {
      psk = null;
      device = { ...device, deviceId: payload.deviceId };
      onPaired({ ...device, hostName: payload.hostName ?? host.hostName });
    }
    channel = createChannel({
      cipher: state.split(),
      cid: join.clientId,
      sendFrame,
      onMessage,
      onError: (error) => log(error.message),
      onOverflow: () => {
        channel?.close();
        channel = null;
        startHandshake();
      },
    });
    onState("ready", { deviceId: device.deviceId, hostName: payload.hostName });
    readyResolve();
  };

  const onMessage = async (message) => {
    if (!message || typeof message !== "object") return;
    if (!message.method && message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      try {
        const result = await onRequest(message.method, message.params ?? {});
        channel?.send({ id: message.id, result });
      } catch (error) {
        channel?.send({ id: message.id, error: { code: -32603, message: String(error?.message || error) } });
      }
      return;
    }
    onNotification(message.method, message.params ?? {});
  };

  const onFrame = (frame) => {
    switch (frame?.t) {
      case "host":
        hostOnline = frame.state === "online";
        if (!hostOnline) onState(frame.state === "closed" ? "closed" : "host-offline");
        else if (channel) channel.replay();
        else startHandshake();
        return;
      case "hs2":
        onHandshakeReply(frame);
        return;
      case "err":
        handshake = null;
        if (frame.code === "unknown_device") device = null;
        readyReject(new Error(`the host refused: ${frame.code}`));
        onState("error", frame.code);
        return;
      case "reset":
        // The host lost this session: handshake again and re-read (§7.4).
        channel?.close();
        channel = null;
        resetReady();
        onState("reset");
        startHandshake();
        return;
      case "d":
      case "a":
        channel?.receive(frame);
        return;
      default:
    }
  };

  const streamLoop = async () => {
    let delay = 1000;
    while (!closed) {
      const abort = new AbortController();
      streamAbort = abort;
      try {
        const response = await fetchImpl(`${relay}/client/stream`, {
          headers: { authorization: `Bearer ${join.clientSession}`, accept: "text/event-stream" },
          signal: abort.signal,
        });
        if (response.status === 401) {
          join = await post("/client/join", { roomId: host.roomId, joinToken: host.joinToken });
          // A new client id is a new session: the host knows nothing of it.
          channel?.close();
          channel = null;
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`the relay's stream answered ${response.status}`);
        delay = 1000;
        const reader = response.body.getReader();
        let carry = "";
        let lastBytes = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastBytes > 45_000) abort.abort();
        }, 5_000);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            lastBytes = Date.now();
            carry += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = carry.indexOf("\n")) >= 0) {
              const line = carry.slice(0, newline).replace(/\r$/, "");
              carry = carry.slice(newline + 1);
              if (line.startsWith("data:")) {
                try {
                  onFrame(JSON.parse(line.slice(5).trim()));
                } catch (error) {
                  log(`bad frame: ${error.message}`);
                }
              }
            }
          }
        } finally {
          clearInterval(watchdog);
        }
      } catch (error) {
        if (closed) return;
        log(`stream: ${error.message}`);
      }
      if (closed) return;
      hostOnline = false;
      onState("connecting");
      await new Promise((resolve) => setTimeout(resolve, delay * (0.8 + Math.random() * 0.4)));
      delay = Math.min(delay * 2, 30_000);
    }
  };

  return {
    /** Join, open the stream, and resolve once the E2E session is up. */
    async connect() {
      onState("connecting");
      join = await post("/client/join", { roomId: host.roomId, joinToken: host.joinToken });
      streamLoop();
      await ready;
    },

    /** Call a host method (§8.1). */
    async request(method, params = {}) {
      await ready;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        channel.send({ id, method, params });
      });
    },

    get device() {
      return device;
    },

    get clientId() {
      return join?.clientId ?? null;
    },

    /** Drop the stream without leaving: the next stream replays (tests). */
    _dropStream() {
      streamAbort?.abort();
    },

    async close() {
      closed = true;
      streamAbort?.abort();
      channel?.close();
      await post("/client/leave", {}).catch(() => {});
      onState("closed");
    },
  };
}
