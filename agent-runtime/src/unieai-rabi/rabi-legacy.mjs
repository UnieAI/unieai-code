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
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Move `<uacDir>/dsh-home` to `<uacDir>/rabi-home` once. Returns what was
 * done, or null when there was nothing to move (already moved, a fresh
 * install, or both exist, in which case the new home wins and the old one is
 * left for the user).
 */
export function migrateLegacyHome(uacDir, { log = () => {} } = {}) {
  const legacy = join(uacDir, LEGACY_HOME_NAME);
  const home = join(uacDir, HOME_NAME);
  if (!existsSync(legacy) || existsSync(home)) return null;
  renameSync(legacy, home);
  for (const dir of REBUILT) rmSync(join(home, dir), { recursive: true, force: true });
  let rewritten = 0;
  let skipped = 0;
  for (const path of sessionLogs(join(home, "sessions"))) {
    try {
      if (rewriteSessionLog(path)) rewritten++;
    } catch (error) {
      skipped++;
      log(`uac: could not migrate ${path}: ${error.message}`);
    }
  }
  log(`uac: moved ${legacy} to ${home} (${rewritten} session logs updated${skipped ? `, ${skipped} skipped` : ""})`);
  return { from: legacy, to: home, rewritten, skipped };
}
