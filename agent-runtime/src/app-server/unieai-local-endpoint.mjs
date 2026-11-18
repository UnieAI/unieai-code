// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-local-endpoint.mjs — where a local server actually listens, per OS.
 *
 * Everything here is named by a socket PATH (`<home>/uac/app-server.sock`),
 * and on Unix that path is the endpoint. Windows has no such thing for Node:
 * `net.listen(path)` there only makes named pipes and rejects any other path
 * with EACCES, while the TUI's Rust client dials AF_UNIX sockets — the two
 * never meet, so every Windows launch fell back to the codex engine.
 *
 * On Windows, then:
 *   - the app-server socket becomes a loopback WebSocket (127.0.0.1, a port
 *     the OS picks) guarded by a bearer token; port and token go into the
 *     stamp beside the path (`<path>.json`), which is where the TUI already
 *     looks to learn about the server. The Rust client already speaks
 *     `ws://` with a token, so nothing new is needed on that side but reading
 *     the stamp.
 *   - sockets only Node talks to (dsh's unieai-control channel) become named
 *     pipes, derived from the path so both ends compute the same name.
 *
 * The path stays the identity in both cases: locks, stamps and the TUI's
 * "is this the uac server?" check keep using it.
 */
import { readFileSync } from "node:fs";

export const IS_WINDOWS = process.platform === "win32";
/** Whether the app-server uses the loopback transport: on Windows, or when
 * UNIEAI_UAC_LOOPBACK=1 forces it elsewhere to exercise that path. */
export const USE_LOOPBACK = IS_WINDOWS || process.env.UNIEAI_UAC_LOOPBACK === "1";

/** FNV-1a, 64-bit, as hex: the TUI hashes socket paths the same way. */
export function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(String(text), "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The named pipe standing in for `path` on Windows. */
export function pipeNameFor(path) {
  return `\\\\.\\pipe\\unieai-${fnv1a64(String(path).toLowerCase())}`;
}

/**
 * What to hand `net.listen` / `net.connect` for a socket only Node peers use:
 * the path itself on Unix, its named pipe on Windows.
 */
export function nodeSocketEndpoint(path, { windows = IS_WINDOWS } = {}) {
  return windows ? pipeNameFor(path) : path;
}

/** Whether `endpoint` is a Windows named pipe (no file to chmod or remove). */
export const isPipeName = (endpoint) => /^\\\\[.?]\\pipe\\/i.test(String(endpoint));

/** The stamp a server left beside its socket path, or null. */
export function readStamp(socketPath) {
  try {
    return JSON.parse(readFileSync(`${socketPath}.json`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Where to dial the app-server named by `socketPath`: `{ path }` on Unix,
 * `{ host, port }` from the stamp on Windows (null when no server stamped one).
 */
export function appServerDialTarget(socketPath, { windows = USE_LOOPBACK, stamp = readStamp } = {}) {
  if (!windows) return { path: socketPath };
  const found = stamp(socketPath);
  const port = Number(found?.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: "127.0.0.1", port, token: found?.token ?? null };
}
