// Copyright (c) 2026 UnieAI. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createStopControls } from "./unieai-launch.mjs";
import { claimServer, socketIsLive, tryClaimLock } from "../unieai-dsh/unieai-server-lock.mjs";

// Unix socket paths must stay under ~108 bytes: keep the scratch dir short.
const scratch = () => mkdtempSync(join(process.env.UNIEAI_TEST_TMP || "/tmp", "uac-l-"));

/** A listening unix socket shaped like startAppServer's result. */
async function listen(socketPath, clients) {
  const net = createServer(() => {});
  await new Promise((resolve) => net.listen(socketPath, resolve));
  return {
    net,
    connections: () => clients.count,
    close: () => new Promise((resolve) => net.close(() => resolve())),
  };
}

const ALIVE = new Set([1001, 1002]);
const isAlive = (pid) => ALIVE.has(pid);

test("SIGTERM with clients hands socket, stamp and lock to the next server; the old one's exit leaves them alone", async () => {
  const dir = scratch();
  try {
    const socketPath = join(dir, "app.sock");
    const stampPath = `${socketPath}.json`;
    const lockPath = `${socketPath}.lock`;

    // Server A (pid 1001) holds the lock and the socket and has a client.
    const releaseA = tryClaimLock(lockPath, { pid: 1001, isAlive });
    assert.equal(typeof releaseA, "function");
    const clients = { count: 1 };
    const serverA = await listen(socketPath, clients);
    writeFileSync(stampPath, JSON.stringify({ pid: 1001 }));
    const exits = [];
    let closedBeforeHandOver = null;
    const a = createStopControls({
      server: serverA,
      socketPath,
      stampPath,
      onHandOver: () => {
        closedBeforeHandOver = !serverA.net.listening;
        releaseA();
      },
      exit: (code) => exits.push(code),
    });

    a.drain();
    assert.equal(closedBeforeHandOver, true, "A stops listening before it gives up the lock");
    assert.equal(existsSync(socketPath), false);
    assert.equal(existsSync(stampPath), false);
    assert.equal(existsSync(lockPath), false, "the lock goes with the socket");
    assert.deepEqual(exits, [], "A keeps serving its client");

    // Server B (pid 1002, another release) now takes the lock and the socket.
    const claimedB = await claimServer(socketPath, {
      timeoutMs: 2_000,
      intervalMs: 5,
      claim: (path) => tryClaimLock(path, { pid: 1002, isAlive }),
    });
    assert.equal(typeof claimedB.release, "function");
    const serverB = await listen(socketPath, { count: 0 });
    writeFileSync(stampPath, JSON.stringify({ pid: 1002 }));

    // A's last client leaves: A stops (onIdle → shutdown), then its process
    // exit handler runs the lock release again.
    clients.count = 0;
    a.drain(); // a second SIGTERM while draining does nothing
    await a.shutdown();
    releaseA();
    assert.deepEqual(exits, [0]);
    assert.equal(await socketIsLive(socketPath), true, "B's socket survives A's exit");
    assert.equal(JSON.parse(readFileSync(stampPath, "utf8")).pid, 1002);
    assert.equal(readFileSync(lockPath, "utf8").trim(), "1002");

    await serverB.close();
    claimedB.release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGTERM with no client stops the server: socket and stamp go, and the lock with the process", async () => {
  const dir = scratch();
  try {
    const socketPath = join(dir, "app.sock");
    const stampPath = `${socketPath}.json`;
    const server = await listen(socketPath, { count: 0 });
    writeFileSync(stampPath, "{}");
    const exits = [];
    let handedOver = false;
    let shutDown = false;
    const stop = createStopControls({
      server,
      socketPath,
      stampPath,
      onShutdown: async () => {
        shutDown = true;
      },
      onHandOver: () => {
        handedOver = true;
      },
      exit: (code) => exits.push(code),
    });
    await stop.drain();
    assert.deepEqual(exits, [0]);
    assert.equal(shutDown, true);
    assert.equal(handedOver, false, "nothing to hand over: the exit releases the lock");
    assert.equal(existsSync(socketPath), false);
    assert.equal(existsSync(stampPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server started while another still holds the lock waits for it rather than starting alongside", async () => {
  const dir = scratch();
  try {
    const socketPath = join(dir, "app.sock");
    const lockPath = `${socketPath}.lock`;
    const releaseA = tryClaimLock(lockPath, { pid: 1001, isAlive });
    let polls = 0;
    const waiting = claimServer(socketPath, {
      timeoutMs: 2_000,
      intervalMs: 5,
      claim: (path) => {
        polls += 1;
        // A hands over (releases) while B is waiting.
        if (polls === 4) releaseA();
        return tryClaimLock(path, { pid: 1002, isAlive });
      },
    });
    const claimed = await waiting;
    assert.ok(polls >= 4, "B did not take the lock while A held it");
    assert.equal(readFileSync(lockPath, "utf8").trim(), "1002");
    claimed.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
