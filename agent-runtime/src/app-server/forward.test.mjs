// The forwarder is what keeps us from reimplementing the platform half of the
// protocol. These use a stub child that speaks the same line-delimited JSON-RPC,
// so the contract is pinned without spawning the real Rust binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForwarder } from "./forward.mjs";

/** A stand-in app-server: echoes requests, and can emit a notification first. */
function stubServer(body) {
  const dir = mkdtempSync(join(tmpdir(), "fwd-"));
  const path = join(dir, "stub.mjs");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return { dir, path };
}

const ECHO = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: "stub/0" } }) + "\\n");
    } else if (msg.method === "boom") {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32000, message: "platform said no" } }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { method: msg.method, params: msg.params } }) + "\\n");
    }
  }
});
`;

test("a forwarded call returns the child's result", async () => {
  const stub = stubServer(ECHO);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    const result = await f.forward("fs/readFile", { path: "/x" });
    assert.deepEqual(result, { method: "fs/readFile", params: { path: "/x" } });
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("concurrent calls are matched back to their own promises", async () => {
  // Our ids and the client's must not collide in the child's namespace, so the
  // forwarder renumbers — this proves the correlation survives interleaving.
  const stub = stubServer(ECHO);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    const [a, b, c] = await Promise.all([
      f.forward("fs/readFile", { n: 1 }),
      f.forward("account/read", { n: 2 }),
      f.forward("config/read", { n: 3 }),
    ]);
    assert.equal(a.params.n, 1);
    assert.equal(b.params.n, 2);
    assert.equal(c.params.n, 3);
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("an error from the platform half rejects with its code", async () => {
  const stub = stubServer(ECHO);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    await assert.rejects(() => f.forward("boom", {}), (e) => {
      assert.match(e.message, /platform said no/);
      assert.equal(e.rpcCode, -32000);
      return true;
    });
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("non-JSON output from the child is ignored, not fatal", async () => {
  // The real binary logs to stdout on occasion; a log line must not derail RPC.
  const stub = stubServer(`process.stdout.write("starting up, not json\\n");\n${ECHO}`);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    assert.deepEqual((await f.forward("fs/getMetadata", {})).method, "fs/getMetadata");
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("notifications from the platform half reach the handler", async () => {
  const stub = stubServer(`process.stdout.write(JSON.stringify({ method: "fs/changed", params: { path: "/a" } }) + "\\n");\n${ECHO}`);
  const seen = [];
  const f = createForwarder({ bin: process.execPath, args: [stub.path], onNotification: (m, p) => seen.push([m, p]) });
  try {
    await f.forward("config/read", {});
    assert.deepEqual(seen, [["fs/changed", { path: "/a" }]]);
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("the child is initialized before anything is forwarded", async () => {
  // The real app-server answers every other method with "Not initialized"
  // (-32600) until the handshake is done, which is exactly how the TUI failed.
  const stub = stubServer(ECHO);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    await f.ready;
    const result = await f.forward("config/read", {});
    assert.equal(result.method, "config/read");
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("a forward issued before the handshake completes still waits for it", async () => {
  const stub = stubServer(ECHO);
  const f = createForwarder({ bin: process.execPath, args: [stub.path] });
  try {
    // No `await f.ready` — the forward must serialise behind it on its own.
    assert.equal((await f.forward("config/read", {})).method, "config/read");
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});

test("a child that dies rejects everything still in flight", async () => {
  const stub = stubServer(`process.exit(3);`);
  const f = createForwarder({ bin: process.execPath, args: [stub.path], onError: () => {} });
  try {
    await assert.rejects(() => f.forward("fs/readFile", {}), /exited/);
  } finally { f.close(); rmSync(stub.dir, { recursive: true, force: true }); }
});
