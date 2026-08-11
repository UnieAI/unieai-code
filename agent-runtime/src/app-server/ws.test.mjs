// The Rust client is the only peer this ever talks to, so the tests pin the
// parts of RFC 6455 it exercises: the upgrade handshake, masked client frames
// (clients MUST mask, servers MUST NOT), the three length encodings, and
// fragmentation. Everything else is deliberately unimplemented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { acceptKey, parseUpgrade, encodeFrame, decodeFrames, serveJsonOverUnixSocket, newClientKey } from "./ws.mjs";

test("acceptKey follows the RFC's published example", () => {
  // RFC 6455 §1.3 worked example — if this drifts, no client will connect.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("parseUpgrade accepts a websocket upgrade and rejects anything else", () => {
  const good = "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\n";
  assert.deepEqual(parseUpgrade(good).ok, true);
  assert.equal(parseUpgrade(good).key, "abc");
  assert.equal(parseUpgrade("GET / HTTP/1.1\r\nHost: x\r\n").ok, false);       // no upgrade header
  assert.equal(parseUpgrade("POST / HTTP/1.1\r\nUpgrade: websocket\r\n").ok, false); // not GET
});

test("the server never masks its frames", () => {
  const frame = encodeFrame("hi");
  assert.equal(frame[0] & 0x80, 0x80);     // FIN
  assert.equal(frame[0] & 0x0f, 0x1);      // text
  assert.equal(frame[1] & 0x80, 0);        // mask bit clear
  assert.equal(frame.subarray(2).toString(), "hi");
});

test("all three length encodings round-trip", () => {
  for (const size of [10, 200, 70_000]) {
    const payload = "x".repeat(size);
    const { frames, rest } = decodeFrames(encodeFrame(payload));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].data.toString(), payload);
    assert.equal(rest.length, 0);
  }
});

/** Mask a payload the way a conforming client must. */
function clientFrame(text, opcode = 0x1) {
  const body = Buffer.from(text, "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  const header = Buffer.alloc(2);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | body.length; // mask bit + short length
  return Buffer.concat([header, mask, masked]);
}

test("masked client frames are unmasked", () => {
  const { frames } = decodeFrames(clientFrame('{"a":1}'));
  assert.equal(frames[0].data.toString(), '{"a":1}');
});

test("a frame split across chunks is held until complete", () => {
  const whole = encodeFrame("hello world");
  const first = decodeFrames(whole.subarray(0, 5));
  assert.equal(first.frames.length, 0);
  const second = decodeFrames(Buffer.concat([first.rest, whole.subarray(5)]), first.carry);
  assert.equal(second.frames[0].data.toString(), "hello world");
});

test("continuation frames are joined into one message", () => {
  const part1 = Buffer.concat([Buffer.from([0x01, 0x03]), Buffer.from("abc")]); // text, no FIN
  const part2 = Buffer.concat([Buffer.from([0x80, 0x03]), Buffer.from("def")]); // continuation, FIN
  const { frames } = decodeFrames(Buffer.concat([part1, part2]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.toString(), "abcdef");
});

test("a JSON message survives the whole path over a real unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-test-"));
  const socketPath = join(dir, "s.sock");
  const received = [];
  const server = serveJsonOverUnixSocket({
    socketPath,
    onConnection: (conn) => {
      conn.onMessage((msg) => { received.push(msg); conn.send({ echo: msg }); });
    },
  });
  await server.listen();
  try {
    const reply = await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buf = Buffer.alloc(0);
      let up = false;
      socket.on("connect", () => {
        socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!up) {
          const end = buf.indexOf("\r\n\r\n");
          if (end < 0) return;
          assert.match(buf.subarray(0, end).toString(), /101 Switching Protocols/);
          buf = buf.subarray(end + 4);
          up = true;
          socket.write(clientFrame(JSON.stringify({ method: "ping", id: 7 })));
        }
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        if (frames.length) { socket.destroy(); resolve(JSON.parse(frames[0].data.toString())); }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timed out")), 4000).unref?.();
    });
    assert.deepEqual(received, [{ method: "ping", id: 7 }]);
    assert.deepEqual(reply, { echo: { method: "ping", id: 7 } });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed frame is reported without dropping the connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-bad-"));
  const socketPath = join(dir, "s.sock");
  const errors = [];
  let live = null;
  const server = serveJsonOverUnixSocket({
    socketPath,
    onConnection: (conn) => { live = conn; conn.onMessage(() => {}); },
    onError: (e) => errors.push(e),
  });
  await server.listen();
  try {
    await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buf = Buffer.alloc(0);
      let up = false;
      socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n\r\n`));
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!up && buf.indexOf("\r\n\r\n") >= 0) {
          up = true;
          socket.write(clientFrame("not json at all"));
          setTimeout(() => { socket.destroy(); resolve(); }, 150);
        }
      });
      socket.on("error", reject);
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /malformed JSON/);
    assert.ok(live, "connection was still established");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
