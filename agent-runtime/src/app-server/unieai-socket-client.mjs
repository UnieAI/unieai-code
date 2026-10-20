// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-socket-client.mjs — a minimal client of the app-server's unix
 * socket, for tests and scripts that need to act like a TUI: send JSON-RPC,
 * wait for a message that matches, answer the server's requests.
 */
import { connect } from "node:net";
import { decodeFrames, newClientKey } from "./ws.mjs";

/** A masked text frame, as a websocket client must send. */
function clientFrame(text) {
  const body = Buffer.from(text);
  const mask = Buffer.from([7, 3, 5, 1]);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  let header;
  if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
  else if (body.length < 65536) header = Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, out]);
}

export function connectSocketClient(socketPath) {
  const socket = connect(socketPath);
  const messages = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  let carry = { opcode: null, chunks: [] };
  let upgraded = false;
  let nextId = 1;
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n\r\n`));
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      buf = buf.subarray(end + 4);
      upgraded = true;
      ready();
    }
    const decoded = decodeFrames(buf, carry);
    buf = decoded.rest;
    carry = decoded.carry;
    for (const frame of decoded.frames) {
      const message = JSON.parse(frame.data.toString());
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  socket.on("error", () => {});
  const client = {
    messages,
    opened,
    send: (message) => socket.write(clientFrame(JSON.stringify(message))),
    /** The first message (already received or yet to come) that matches. */
    next(match, { timeoutMs = 10_000 } = {}) {
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
        waiters.push({ match, resolve: (message) => (clearTimeout(timer), resolve(message)) });
      });
    },
    /** Call a method and wait for its answer. */
    async call(method, params = {}) {
      await opened;
      const id = nextId++;
      client.send({ id, method, params });
      const reply = await client.next((m) => m.id === id && !m.method);
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      return reply.result;
    },
    close: () => socket.destroy(),
  };
  return client;
}
