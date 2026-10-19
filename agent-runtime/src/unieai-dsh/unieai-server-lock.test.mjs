// Copyright (c) 2026 UnieAI. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimServer, socketIsLive, tryClaimLock } from "./unieai-server-lock.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "uac-lock-"));

test("the first server takes the lock, a second one alongside does not", () => {
  const lock = join(scratch(), "app.sock.lock");
  const release = tryClaimLock(lock, { pid: 1001, isAlive: (pid) => pid === 1001 });
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(lock, "utf8").trim(), "1001");
  assert.equal(tryClaimLock(lock, { pid: 1002, isAlive: (pid) => pid === 1001 }), null);
  release();
  assert.equal(existsSync(lock), false);
});

test("a lock left by a server that is gone is taken over", () => {
  const lock = join(scratch(), "app.sock.lock");
  writeFileSync(lock, "999999\n");
  const release = tryClaimLock(lock, { pid: 1002, isAlive: () => false });
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(lock, "utf8").trim(), "1002");
});

test("releasing does not remove a lock a successor has taken", () => {
  const lock = join(scratch(), "app.sock.lock");
  const release = tryClaimLock(lock, { pid: 1001, isAlive: () => false });
  writeFileSync(lock, "1002\n");
  release();
  assert.equal(readFileSync(lock, "utf8").trim(), "1002");
});

test("a server that lost the race waits for the winner to answer, then stands down", async () => {
  const dir = scratch();
  const socketPath = join(dir, "app.sock");
  writeFileSync(`${socketPath}.lock`, `${process.pid}\n`);
  let polls = 0;
  const result = await claimServer(socketPath, {
    intervalMs: 5,
    isLive: async () => (polls += 1) >= 3,
  });
  assert.deepEqual(result, { release: null });
  assert.equal(polls, 3);
});

test("socketIsLive tells a listening socket from a missing one", async () => {
  const socketPath = join(scratch(), "live.sock");
  assert.equal(await socketIsLive(socketPath), false);
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    assert.equal(await socketIsLive(socketPath), true);
  } finally {
    server.close();
  }
});
