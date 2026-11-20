// Copyright (c) 2026 UnieAI. All rights reserved.
// Windows has no unix sockets for Node: the app-server listens on loopback
// with a token there, and Node-only sockets become named pipes. These pin the
// pieces that can run on any OS: the endpoint mapping, the token check, and a
// real loopback round trip with and without the token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { appServerDialTarget, fnv1a64, isPipeName, nodeSocketEndpoint, pipeNameFor } from "./unieai-local-endpoint.mjs";
import { bearerMatches, newClientKey, serveJsonOverUnixSocket } from "./ws.mjs";
import { socketIsLive } from "../unieai-rabi/unieai-server-lock.mjs";

test("fnv1a64 matches the published test vectors", () => {
  assert.equal(fnv1a64(""), "cbf29ce484222325");
  assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
});

test("a Node-only socket is its path on Unix and a named pipe on Windows", () => {
  const path = "C:\\Users\\user\\.unieai\\uac\\app-server.123.rabi.sock";
  assert.equal(nodeSocketEndpoint(path, { windows: false }), path);
  const pipe = nodeSocketEndpoint(path, { windows: true });
  assert.match(pipe, /^\\\\\.\\pipe\\unieai-[0-9a-f]{16}$/);
  assert.ok(isPipeName(pipe));
  assert.ok(!isPipeName(path));
  // Both ends derive it, so it must be stable and case-blind like the path.
  assert.equal(pipe, pipeNameFor(path.toUpperCase()));
  assert.notEqual(pipe, pipeNameFor(path.replace("123", "124")));
});

test("the dial target comes from the stamp on Windows", () => {
  const stamp = () => ({ port: 50123, token: "t" });
  assert.deepEqual(appServerDialTarget("/x.sock", { windows: false, stamp }), { path: "/x.sock" });
  assert.deepEqual(appServerDialTarget("x.sock", { windows: true, stamp }), { host: "127.0.0.1", port: 50123, token: "t" });
  // No stamp yet (server still starting) or one from a release without ports.
  assert.equal(appServerDialTarget("x.sock", { windows: true, stamp: () => null }), null);
  assert.equal(appServerDialTarget("x.sock", { windows: true, stamp: () => ({ pid: 4 }) }), null);
});

test("bearerMatches wants exactly the token", () => {
  assert.ok(bearerMatches("Bearer abc", "abc"));
  assert.ok(bearerMatches("bearer  abc ", "abc"));
  assert.ok(!bearerMatches("Bearer abd", "abc"));
  assert.ok(!bearerMatches("Bearer abcd", "abc"));
  assert.ok(!bearerMatches("abc", "abc"));
  assert.ok(!bearerMatches(undefined, "abc"));
});

/** Send an upgrade to 127.0.0.1:port and return the status line. */
function upgradeStatus(port, headers = "") {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(`GET /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n${headers}\r\n`),
    );
    socket.once("data", (chunk) => {
      resolve(chunk.toString("utf8").split("\r\n")[0]);
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

test("loopback mode listens on 127.0.0.1 and refuses upgrades without the token", async () => {
  const server = serveJsonOverUnixSocket({ socketPath: "unused", loopback: true, authToken: "s3cret", onConnection: () => {} });
  await server.listen();
  try {
    const port = server.port();
    assert.ok(Number.isInteger(port) && port > 0);
    assert.match(await upgradeStatus(port), /^HTTP\/1\.1 401/);
    assert.match(await upgradeStatus(port, "Authorization: Bearer wrong\r\n"), /^HTTP\/1\.1 401/);
    assert.match(await upgradeStatus(port, "Authorization: Bearer s3cret\r\n"), /^HTTP\/1\.1 101/);
  } finally {
    await server.close();
  }
});

test("socketIsLive follows the stamp's port where there is no socket file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uac-endpoint-"));
  const socketPath = join(dir, "app-server.sock");
  const server = serveJsonOverUnixSocket({ socketPath, loopback: true, authToken: "t", onConnection: () => {} });
  await server.listen();
  const target = (path) => appServerDialTarget(path, { windows: true });
  try {
    assert.equal(await socketIsLive(socketPath, 600, { target }), false); // nothing stamped yet
    writeFileSync(`${socketPath}.json`, JSON.stringify({ pid: process.pid, port: server.port(), token: "t" }));
    assert.equal(await socketIsLive(socketPath, 600, { target }), true);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
