// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-server-lock.mjs — one uac server per app-server socket.
 *
 * Every TUI that finds no server running starts one, so two sessions opened
 * together (or reopened after the idle exit) start two. Each spawned its own
 * dsh before binding the app socket, and both dsh processes bound the same
 * unieai-control socket: whichever bound last took it. The server that won
 * the app socket then sent registerTools / steer / setPermissions to the
 * other dsh, which answered "session is not open" — a session started that
 * way had none of the TUI's tools (no list_peers, no send_peer_message) and
 * could not be steered. The loser, failing to bind, also left its dsh
 * running with no parent.
 *
 * So a server first takes `<socket>.lock` (created exclusively, holding its
 * pid). One that cannot, because a live server holds it, starts nothing: it
 * waits until that server answers on the socket and exits, which is what the
 * TUI that launched it is waiting for. A lock whose holder is gone is taken
 * over.
 *
 * A server that hands its socket to another release (unieai-launch's drain)
 * releases the lock at the hand-over, not at its exit: it keeps serving the
 * clients it has, and the new release's server must be able to take the lock
 * and the socket meanwhile. Each server's dsh control socket carries its pid,
 * so the two run side by side without sharing one.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { connect } from "node:net";

/** Whether `pid` is a running process (signal 0 only checks). */
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return error?.code === "EPERM";
  }
}

/** Whether something accepts connections on the unix socket at `path`. */
export function socketIsLive(path, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = connect(path);
    const done = (live) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Take the lock at `lockPath` for this process. Returns a release function,
 * or null when a live process holds it.
 */
export function tryClaimLock(lockPath, { pid = process.pid, isAlive = processIsAlive } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        // Once: a server that handed its socket over released the lock then,
        // and its exit must not look at the path the successor now holds.
        if (released) return;
        released = true;
        // Only our own lock: a successor may already have taken a stale one.
        try {
          if (Number.parseInt(readFileSync(lockPath, "utf8"), 10) === pid) rmSync(lockPath, { force: true });
        } catch {
          // Already gone.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let holder = null;
    try {
      holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
    } catch {
      // Removed between the two calls: try again.
      continue;
    }
    if (holder === pid || isAlive(holder)) return null;
    // Its server is gone (killed, crashed): the lock is stale.
    rmSync(lockPath, { force: true });
  }
  return null;
}

/**
 * Become the server for `socketPath`, or learn that another one is.
 * Resolves to `{ release }` for the caller to serve, or `{ release: null }`
 * once another server answers on the socket. Rejects when neither happens in
 * `timeoutMs`.
 */
export async function claimServer(
  socketPath,
  { timeoutMs = 30_000, intervalMs = 200, claim = tryClaimLock, isLive = socketIsLive } = {},
) {
  const lockPath = `${socketPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = claim(lockPath);
    if (release) return { release };
    if (await isLive(socketPath)) return { release: null };
    if (Date.now() >= deadline) {
      throw new Error(`another uac server holds ${lockPath} but never answered on ${socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
