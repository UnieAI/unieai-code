// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * rabi-legacy.mjs — carry an install from before the Rabi rename across.
 *
 * Until 0.0.41 the uac engine ran the upstream harness under its own names:
 * its home was `$CODEX_HOME/uac/dsh-home` and our knobs were UNIEAI_DSH_*.
 * This is the one place that still knows those names:
 *
 *  - adoptLegacyEnv(): an old variable still works when its new name is
 *    unset (a deployment or benchmark script that sets UNIEAI_DSH_PLUGINS).
 *  - migrateLegacyHome(): the old home moves to `rabi-home`. Sessions and
 *    attachments move with it; profiles and caches are dropped because Rabi
 *    rebuilds them, and they name the old packages. Session logs record
 *    which plugin wrote each entry, so their package names are rewritten
 *    (and only those: a session also holds the user's own words).
 *
 * An upgrade does not stop the old release at once: its uac server hands the
 * socket to the new one and keeps serving the windows it has (unieai-launch's
 * drain), and its rabi keeps writing under dsh-home by path. Moving the
 * directory under it would fail its writes or make it start a second
 * dsh-home. So while an old server is alive the move waits: the new release
 * runs on a fresh rabi-home, an old conversation resumed there says to close
 * the older windows (legacySessionPresent), and a later start, once the old
 * server is gone, merges dsh-home into rabi-home.
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { rewritePackageNames } from "./rabi-rewrite.mjs";

export const LEGACY_HOME_NAME = "dsh-home";
export const HOME_NAME = "rabi-home";

/** Old variable → new variable. */
export const LEGACY_ENV = {
  DSH_HOME: "RABI_HOME",
  UNIEAI_DSH_BIN: "UNIEAI_RABI_BIN",
  UNIEAI_DSH_PATCH: "UNIEAI_RABI_PATCH",
  UNIEAI_DSH_PLUGINS: "UNIEAI_RABI_PLUGINS",
};

/** Copy each set old variable to its new name when that is unset; returns `env`. */
export function adoptLegacyEnv(env = process.env) {
  for (const [legacy, current] of Object.entries(LEGACY_ENV)) {
    if (env[legacy] !== undefined && env[current] === undefined) env[current] = env[legacy];
  }
  return env;
}

/** Rebuilt by Rabi on start; they name the old packages. */
const REBUILT = ["profiles", "cache", join("storages", "session_projcache")];

function* sessionLogs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionLogs(path);
    else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) yield path;
  }
}

const ZSTD_MAGIC = 0xfd2fb528;

/**
 * Byte ranges of the zstd frames in a session log. Rabi appends one frame
 * per write and node's one-shot decoder stops after the first, so each frame
 * is decoded on its own. Mirrors the frame walk of Rabi's session store
 * (upstream, MIT). Throws on a torn or foreign frame: such a log is left for
 * Rabi's own repair.
 */
export function zstdFrames(buf) {
  const frames = [];
  let pos = 0;
  const need = (n) => {
    if (buf.length - pos < n) throw new Error("torn zstd frame");
  };
  while (pos < buf.length) {
    const start = pos;
    need(5);
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) throw new Error(`not a zstd frame at byte ${pos}`);
    const descriptor = buf[pos + 4];
    pos += 5;
    const singleSegment = (descriptor & 0x20) !== 0;
    const sizeFlag = descriptor >>> 6;
    const dictFlag = descriptor & 3;
    pos += (singleSegment ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag) + (sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag);
    for (;;) {
      need(3);
      const header = buf.readUIntLE(pos, 3);
      pos += 3;
      const type = (header >>> 1) & 3;
      if (type === 3) throw new Error(`reserved zstd block type at byte ${pos - 3}`);
      need(type === 1 ? 1 : header >>> 3);
      pos += type === 1 ? 1 : header >>> 3;
      if (header & 1) break;
    }
    if (descriptor & 4) {
      need(4);
      pos += 4;
    }
    frames.push(buf.subarray(start, pos));
  }
  return frames;
}

function rewriteSessionLog(path) {
  const zstd = path.endsWith(".zstd");
  if (zstd && typeof zlib.zstdDecompressSync !== "function") return false;
  const raw = readFileSync(path);
  let next;
  if (zstd) {
    // Frame by frame, so the log keeps the shape Rabi wrote (one checksummed frame per batch).
    let changed = false;
    const frames = zstdFrames(raw).map((frame) => {
      const text = zlib.zstdDecompressSync(frame).toString("utf8");
      const rewritten = rewritePackageNames(text);
      if (rewritten === text) return frame;
      changed = true;
      return zlib.zstdCompressSync(Buffer.from(rewritten, "utf8"), { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
    });
    if (!changed) return false;
    next = Buffer.concat(frames);
  } else {
    const text = raw.toString("utf8");
    next = rewritePackageNames(text);
    if (next === text) return false;
  }
  const tmp = `${path}.rabi-migrate`;
  writeFileSync(tmp, next);
  renameSync(tmp, path);
  return true;
}

/** Files Rabi or uac write afresh on every start; the old copies are not kept. */
const REGENERATED = /^(settings\.yaml(\..*)?|\.credentials\.yaml|uac(\.[a-z]+)?\.patch\.yml)$/;
/**
 * An old server's rabi control socket: the app-server socket's name with
 * `.<pid>[.<mode>].dsh.sock` in place of `.sock` (app-server.4242.dsh.sock).
 */
const LEGACY_CONTROL_SOCKET = /\.(\d+)\.(?:[a-z]+\.)?dsh\.sock/g;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  // A recycled pid is not an old server; Linux can say which program it is.
  try {
    return /unieai-uac-server/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return true;
  }
}

/**
 * Pids of uac servers from before the rename that are still running. Each
 * one names its rabi control socket, pid included, in the patch it writes
 * into dsh-home (every platform), and on POSIX that socket is also a file
 * beside the app-server socket.
 */
export function legacyServerPids(uacDir, { socketDirs = [] } = {}) {
  const legacy = join(uacDir, LEGACY_HOME_NAME);
  const pids = new Set();
  const collect = (text) => {
    for (const m of String(text).matchAll(LEGACY_CONTROL_SOCKET)) pids.add(Number(m[1]));
  };
  try {
    for (const name of readdirSync(legacy)) {
      if (/^uac(\.[a-z]+)?\.patch\.yml$/.test(name)) collect(readFileSync(join(legacy, name), "utf8"));
    }
  } catch {}
  for (const dir of new Set([uacDir, ...socketDirs])) {
    try {
      collect(readdirSync(dir).join("\n"));
    } catch {}
  }
  return [...pids].filter(alive).sort((a, b) => a - b);
}

/** Whether a conversation is still only in the old home (its move is waiting). */
export function legacySessionPresent(uacDir, sessionId) {
  const sessions = join(uacDir, LEGACY_HOME_NAME, "sessions");
  try {
    return readdirSync(sessions).some((dir) => existsSync(join(sessions, dir, sessionId)));
  } catch {
    return false;
  }
}

/**
 * Move what `from` has and `to` lacks; where both have a directory, look
 * inside. Returns the paths left behind because `to` already had them.
 */
function mergeMove(from, to, left = []) {
  if (!existsSync(to)) {
    renameSync(from, to);
    return left;
  }
  if (!statSync(from).isDirectory() || !statSync(to).isDirectory()) {
    left.push(from);
    return left;
  }
  for (const name of readdirSync(from)) mergeMove(join(from, name), join(to, name), left);
  return left;
}

/** Remove empty directories under (and including) `dir`. */
function pruneEmpty(dir) {
  if (!statSync(dir).isDirectory()) return false;
  for (const name of readdirSync(dir)) pruneEmpty(join(dir, name));
  if (readdirSync(dir).length) return false;
  rmdirSync(dir);
  return true;
}

/**
 * Carry `<uacDir>/dsh-home` into `<uacDir>/rabi-home`. Returns what was
 * done, `{ deferred: true, pids }` while an old server still runs on it, or
 * null when there is no old home. When rabi-home already exists (a start
 * while the move waited) the two are merged: a conversation either side has
 * is kept, and anything both have stays in the new home; the old copies of
 * those are left in `dsh-home.unmerged-<time>` for the user.
 */
export function migrateLegacyHome(uacDir, { log = () => {}, socketDirs = [] } = {}) {
  const legacy = join(uacDir, LEGACY_HOME_NAME);
  const home = join(uacDir, HOME_NAME);
  if (!existsSync(legacy)) return null;
  const pids = legacyServerPids(uacDir, { socketDirs });
  if (pids.length) {
    log(`rabi: ${legacy} is still in use by an older UnieAI Code (pid ${pids.join(", ")}); it moves to ${home} once that exits`);
    return { deferred: true, pids };
  }
  for (const dir of REBUILT) rmSync(join(legacy, dir), { recursive: true, force: true });
  let merged = false;
  let left = [];
  if (!existsSync(home)) {
    renameSync(legacy, home);
  } else {
    merged = true;
    for (const name of readdirSync(legacy)) {
      if (REGENERATED.test(name)) rmSync(join(legacy, name), { force: true });
      else mergeMove(join(legacy, name), join(home, name), left);
    }
    if (!pruneEmpty(legacy)) {
      const unmerged = `${legacy}.unmerged-${Date.now()}`;
      renameSync(legacy, unmerged);
      left = left.map((path) => unmerged + path.slice(legacy.length));
      log(`rabi: ${left.length} item(s) of ${legacy} were already in ${home}; the old copies are in ${unmerged}`);
    }
  }
  let rewritten = 0;
  let skipped = 0;
  for (const path of sessionLogs(join(home, "sessions"))) {
    try {
      if (rewriteSessionLog(path)) rewritten++;
    } catch (error) {
      skipped++;
      log(`rabi: could not migrate ${path}: ${error.message}`);
    }
  }
  log(`rabi: ${merged ? "merged" : "moved"} ${legacy} ${merged ? "into" : "to"} ${home} (${rewritten} session logs updated${skipped ? `, ${skipped} skipped` : ""})`);
  return { from: legacy, to: home, merged, left, rewritten, skipped };
}
