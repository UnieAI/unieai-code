// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-channel.mjs — one end of an established Remote Control
 * session: JSON-RPC messages in, encrypted `d` frames out, and back.
 *
 * docs/unieai/remote-control-protocol.md §7. Shared by the host's bridge and
 * the browser (the reference relay serves this file to its test page), so it
 * uses nothing from Node.
 *
 *  - Every message becomes one or more `d` frames: `seq` counts from 1 per
 *    direction and is the AEAD nonce; large messages are chunked inside the
 *    ciphertext, so the relay never sees message boundaries.
 *  - `ack` is end to end and cumulative. Frames stay in a replay buffer until
 *    the peer acknowledges them, and `replay()` sends them again (same bytes)
 *    after a reconnect. The receiver delivers only the next `seq`.
 *  - A frame that fails to decrypt is reported (`onError`), never delivered.
 */
import { fromBase64Url, toBase64Url } from "./unieai-remote-noise.mjs";

export const CHUNK_BYTES = 32 * 1024;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CHUNKS = 1024;
export const REPLAY_FRAMES = 4096;
export const REPLAY_BYTES = 32 * 1024 * 1024;
const ACK_DELAY_MS = 250;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `cipher` is `{ send, receive }` from the handshake's `split()`.
 * `sendFrame(frame)` hands a frame to the relay link; `onMessage(message)`
 * receives each JSON-RPC message; `onOverflow()` runs when the peer has been
 * away so long the replay buffer is full (the session must be reset).
 */
export function createChannel({ cipher, cid, sendFrame, onMessage, onError = () => {}, onOverflow = () => {}, ackDelayMs = ACK_DELAY_MS }) {
  let sentSeq = 0;
  let delivered = 0;
  let ackedByPeer = 0;
  let lastAckSent = 0;
  let unackedBytes = 0;
  const unacked = []; // frames the peer has not acknowledged, in order
  let ackTimer = null;
  let chunkGroup = 0;
  let assembly = null; // { id, n, parts: [] , bytes }
  let closed = false;

  const sendAckSoon = () => {
    if (ackTimer || closed) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (closed || delivered === lastAckSent) return;
      lastAckSent = delivered;
      sendFrame({ t: "a", cid, ack: delivered });
    }, ackDelayMs);
  };

  const onAck = (ack) => {
    if (!Number.isInteger(ack) || ack <= ackedByPeer) return;
    ackedByPeer = Math.min(ack, sentSeq);
    while (unacked.length && unacked[0].seq <= ackedByPeer) unackedBytes -= unacked.shift().b.length;
  };

  const sendPlain = (payload) => {
    const seq = ++sentSeq;
    const sealed = cipher.send.encrypt(seq, encoder.encode(JSON.stringify(payload)));
    const frame = { t: "d", cid, seq, ack: delivered, b: toBase64Url(sealed) };
    lastAckSent = delivered;
    unacked.push(frame);
    unackedBytes += frame.b.length;
    if (unacked.length > REPLAY_FRAMES || unackedBytes > REPLAY_BYTES) {
      onOverflow();
      return;
    }
    sendFrame(frame);
  };

  const deliver = (payload) => {
    if (payload && typeof payload === "object" && "m" in payload) {
      assembly = null;
      onMessage(payload.m);
      return;
    }
    const chunk = payload?.k;
    if (!chunk || typeof payload.p !== "string") throw new Error("malformed payload");
    const { id, i, n } = chunk;
    if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNKS || !Number.isInteger(i) || i < 0 || i >= n) throw new Error("malformed chunk");
    if (!assembly || assembly.id !== id || i === 0) assembly = { id, n, parts: [], bytes: 0 };
    if (i !== assembly.parts.length || n !== assembly.n) {
      assembly = null;
      throw new Error("chunk out of order");
    }
    const part = fromBase64Url(payload.p);
    assembly.bytes += part.length;
    if (assembly.bytes > MAX_MESSAGE_BYTES) {
      assembly = null;
      throw new Error("message too large");
    }
    assembly.parts.push(part);
    if (assembly.parts.length < n) return;
    const whole = new Uint8Array(assembly.bytes);
    let at = 0;
    for (const p of assembly.parts) {
      whole.set(p, at);
      at += p.length;
    }
    assembly = null;
    onMessage(JSON.parse(decoder.decode(whole)));
  };

  return {
    cid,

    /** Send one JSON-RPC message. */
    send(message) {
      if (closed) return false;
      const bytes = encoder.encode(JSON.stringify(message));
      if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("message too large to send");
      if (bytes.length <= CHUNK_BYTES) {
        sendPlain({ m: message });
        return true;
      }
      const id = ++chunkGroup;
      const n = Math.ceil(bytes.length / CHUNK_BYTES);
      for (let i = 0; i < n; i++) {
        sendPlain({ k: { id, i, n }, p: toBase64Url(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) });
      }
      return true;
    },

    /** A frame from the peer (`d` or `a`). */
    receive(frame) {
      if (closed) return;
      onAck(frame.ack);
      if (frame.t !== "d") return;
      if (!Number.isInteger(frame.seq) || frame.seq <= delivered) {
        // Already have it (a replay): acknowledge again so the peer can let go.
        sendAckSoon();
        return;
      }
      // A gap: the peer's next replay fills it in.
      if (frame.seq !== delivered + 1) return;
      let payload;
      try {
        payload = JSON.parse(decoder.decode(cipher.receive.decrypt(frame.seq, fromBase64Url(frame.b))));
      } catch (error) {
        onError(new Error(`frame ${frame.seq} did not decrypt`, { cause: error }));
        return;
      }
      delivered = frame.seq;
      sendAckSoon();
      try {
        deliver(payload);
      } catch (error) {
        onError(error);
      }
    },

    /** Send every unacknowledged frame again, in order (after a reconnect). */
    replay() {
      if (closed) return;
      for (const frame of unacked) sendFrame({ ...frame, ack: delivered });
      if (!unacked.length && delivered > 0) sendFrame({ t: "a", cid, ack: delivered });
      lastAckSent = delivered;
    },

    close() {
      closed = true;
      if (ackTimer) clearTimeout(ackTimer);
      ackTimer = null;
    },

    stats: () => ({ sentSeq, delivered, ackedByPeer, unacked: unacked.length, unackedBytes }),
  };
}
