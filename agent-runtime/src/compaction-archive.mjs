/**
 * compaction-archive.mjs — keep what compaction folds away.
 *
 * Compaction replaces a stretch of history with a summary. Whatever the summary
 * omits is simply gone: nobody can tell afterwards what was dropped, and a
 * summary that missed the one decision that mattered looks exactly like a
 * summary that missed nothing.
 *
 * Writing the originals out first buys two things at once:
 *
 *   · Recovery — if the summary turns out to have lost something, the source is
 *     still on disk instead of only in a context window that has moved on.
 *   · Measurement — each record pairs the ORIGINAL messages with the summary
 *     that replaced them, which is what an evaluation of summary quality needs.
 *
 * Storage mirrors the tool-output store: under UNIEAI_HOME, swept by age, and
 * best-effort throughout. A failure here is logged by the caller and swallowed;
 * losing an archive must never cost a turn.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

const DIR_NAME = "compaction-archive";

/** Archives are for diagnosis and evaluation, not permanent record. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function archiveDir() {
  const dir = join(unieaiHome(), DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Drop archives past the retention window. Best-effort and silent. */
function sweep(dir) {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch { /* one bad entry must not stop the sweep */ }
    }
  } catch { /* unreadable store — nothing to sweep */ }
}

let seq = 0;

/**
 * Build the `archive` sink `compactWithSummary` expects.
 *
 * `sessionId` names the file so records can be traced back to a conversation;
 * a counter plus timestamp keeps repeated folds in one session distinct.
 */
export function createCompactionArchive({ sessionId = "session", dir = null } = {}) {
  return async function archive(record) {
    const target = dir ?? archiveDir();
    mkdirSync(target, { recursive: true });
    sweep(target);

    const base = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "session";
    const stamp = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const file = join(target, `${base}-${stamp}.json`);

    const body = {
      sessionId,
      at: new Date().toISOString(),
      requestId: record?.requestId ?? null,
      tokensBefore: record?.tokensBefore ?? null,
      systemCount: record?.systemCount ?? null,
      foldedCount: record?.foldedCount ?? null,
      keptCount: record?.keptCount ?? null,
      prevSummary: record?.prevSummary ?? "",
      summary: record?.summary ?? "",
      // The originals are the whole point — stored verbatim, not truncated.
      folded: Array.isArray(record?.folded) ? record.folded : [],
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return file;
  };
}

/** List archived folds, newest first. For the evaluation tooling. */
export function listArchives({ dir = null, limit = 100 } = {}) {
  const target = dir ?? archiveDir();
  let names;
  try {
    names = readdirSync(target).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const path = join(target, name);
    try {
      rows.push({ path, mtime: statSync(path).mtimeMs });
    } catch { /* vanished between listing and stat */ }
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** Read one archived fold back, or null if it is unreadable. */
export function readArchive(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
