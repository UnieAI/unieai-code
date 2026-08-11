/**
 * ws.mjs — the small slice of RFC 6455 an app-server connection needs.
 *
 * The CLI's app-server protocol is JSON-RPC carried as WebSocket text frames
 * over a Unix socket (see codex-rs/app-server-daemon/src/client.rs: it dials the
 * socket, upgrades with `client_async("ws://localhost/")`, then exchanges one
 * JSON message per text frame). Implementing that here rather than depending on
 * `ws` keeps agent-runtime dependency-free, which is a deliberate property of
 * this package — a library other people embed should not drag a transport in.
 *
 * Deliberately partial: no extensions, no compression, no TLS. Both peers are
 * local processes we ship, so the negotiation surface is one handshake and the
 * frame types a JSON-RPC stream actually uses.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value proving we read the client's key. */
export function acceptKey(clientKey) {
  return createHash("sha1").update(String(clientKey) + GUID).digest("base64");
}

/**
 * Parse an HTTP upgrade request. Returns { key, ok } — `ok` is false when this
 * is not a WebSocket upgrade, which is a protocol error rather than a retry.
 */
export function parseUpgrade(text) {
  const [requestLine, ...lines] = String(text).split("\r\n");
  if (!/^GET\s/i.test(requestLine || "")) return { ok: false };
  const headers = new Map();
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const upgrade = (headers.get("upgrade") || "").toLowerCase();
  const key = headers.get("sec-websocket-key");
  if (upgrade !== "websocket" || !key) return { ok: false };
  return { ok: true, key, headers };
}

/** Encode one frame. Servers never mask (RFC 6455 §5.1). */
export function encodeFrame(payload, { opcode = 0x1 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // Node buffers cap well below 2^53, so the high word is always zero.
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, body]);
}

/**
 * Pull whole frames out of `buffer`.
 * Returns { frames, rest } — `rest` is the incomplete tail to keep for next time.
 * Continuation frames are joined, so a caller sees whole messages.
 */
export function decodeFrames(buffer, carry = { opcode: null, chunks: [] }) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let cursor = offset + 2;
    if (len === 126) {
      if (cursor + 2 > buffer.length) break;
      len = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (cursor + 8 > buffer.length) break;
      // The high word would mean a >4GB message; nothing here sends one.
      len = buffer.readUInt32BE(cursor) * 2 ** 32 + buffer.readUInt32BE(cursor + 4);
      cursor += 8;
    }
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + len > buffer.length) break; // frame still arriving
    const body = Buffer.from(buffer.subarray(cursor, cursor + len));
    if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    cursor += len;
    offset = cursor;

    if (opcode === 0x0) {
      carry.chunks.push(body);
    } else if (opcode === 0x1 || opcode === 0x2) {
      carry.opcode = opcode;
      carry.chunks = [body];
    } else {
      // Control frame: never fragmented, delivered as-is.
      frames.push({ opcode, data: body });
      continue;
    }
    if (fin) {
      frames.push({ opcode: carry.opcode, data: Buffer.concat(carry.chunks) });
      carry.opcode = null;
      carry.chunks = [];
    }
  }
  return { frames, rest: buffer.subarray(offset), carry };
}

/**
 * Serve JSON messages over a Unix socket.
 *
 * `onConnection(conn)` receives `{ send(obj), close(), onMessage(fn), onClose(fn) }`.
 * Every message is one JSON value; malformed text is reported through `onError`
 * rather than killing the connection, because one bad frame from a client should
 * not take down a session.
 */
export function serveJsonOverUnixSocket({ socketPath, onConnection, onError = () => {} }) {
  const server = createServer((socket) => {
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    let carry = { opcode: null, chunks: [] };
    const listeners = { message: [], close: [] };
    const conn = {
      send(obj) {
        if (!upgraded || socket.destroyed) return false;
        socket.write(encodeFrame(JSON.stringify(obj)));
        return true;
      },
      close() { try { socket.end(encodeFrame(Buffer.alloc(0), { opcode: 0x8 })); } catch { socket.destroy(); } },
      onMessage(fn) { listeners.message.push(fn); },
      onClose(fn) { listeners.close.push(fn); },
      socket,
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return; // headers still arriving
        const { ok, key } = parseUpgrade(buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 4);
        if (!ok) {
          socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
          return;
        }
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
        );
        upgraded = true;
        try { onConnection(conn); } catch (e) { onError(e); }
      }
      const decoded = decodeFrames(buffer, carry);
      buffer = decoded.rest;
      carry = decoded.carry;
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) { conn.close(); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.data, { opcode: 0xa })); continue; }
        if (frame.opcode !== 0x1) continue; // binary/pong: nothing here sends them
        let parsed;
        try { parsed = JSON.parse(frame.data.toString("utf8")); }
        catch (e) { onError(new Error(`malformed JSON frame: ${e.message}`)); continue; }
        for (const fn of listeners.message) {
          try { fn(parsed); } catch (e) { onError(e); }
        }
      }
    });
    socket.on("error", (e) => onError(e));
    socket.on("close", () => { for (const fn of listeners.close) { try { fn(); } catch (e) { onError(e); } } });
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve(socketPath));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    server,
  };
}

/** A client key, for tests and for any future outbound connection. */
export const newClientKey = () => randomBytes(16).toString("base64");
