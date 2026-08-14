/**
 * session-rollout.mjs — an append-only log of session-tree entries.
 *
 * `session-tree-store.mjs` writes the whole tree to one file, atomically, when a
 * turn ends. That is a fine snapshot and a poor record: a crash mid-turn loses
 * everything since the last save, and a long coding turn is exactly where that
 * hurts — an hour of tool work, gone, because the process was killed before it
 * reached `persist()`.
 *
 * So entries are also appended here the moment the tree gains them, one JSONL
 * line each. codex does the same thing for the same reason (its rollout records
 * each response item as it happens, and flushes before terminal events).
 *
 * Snapshot and log are not two sources of truth. The tree is append-only, so a
 * log line either names an entry the snapshot already has — and is ignored — or
 * names one it does not, and is replayed. Entry ids are unique per session and
 * deterministic, which is what makes that dedup exact rather than a guess.
 *
 * Nothing here throws at the caller. A rollout is insurance; failing to write it
 * must never take down the turn it was insuring.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

export const ROLLOUT_FORMAT = "unieai.session-rollout";
export const ROLLOUT_VERSION = 1;

const ROLLOUT_DIR_NAME = "agent-rollouts";

/** Same sanitising as the other stores, so one id names one file everywhere. */
function safeId(id) {
  return String(id).replace(/[^\w.-]/g, "");
}

export function rolloutsDir() {
  const dir = join(unieaiHome(), ROLLOUT_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function rolloutPath(id, { dir = null } = {}) {
  return join(dir ?? rolloutsDir(), `${safeId(id)}.jsonl`);
}

/**
 * Append records. Each is one line, so a torn write can only damage the last
 * line — and `readRollout` drops a line it cannot parse rather than refusing the
 * whole file, which is the difference between losing one entry and losing a
 * session.
 *
 * Returns the number of records written (0 on any failure).
 */
export function appendRollout(id, records, { dir = null } = {}) {
  const list = (Array.isArray(records) ? records : [records]).filter(Boolean);
  if (!list.length) return 0;
  try {
    const target = dir ?? rolloutsDir();
    mkdirSync(target, { recursive: true });
    const body = list.map((r) => JSON.stringify({ v: ROLLOUT_VERSION, ...r })).join("\n") + "\n";
    appendFileSync(join(target, `${safeId(id)}.jsonl`), body, "utf8");
    return list.length;
  } catch {
    return 0; // insurance that fails is still better than a turn that dies
  }
}

/** Record helpers, so callers name what happened rather than build shapes. */
export const rolloutEntry = (entry) => ({ t: "entry", e: entry });
export const rolloutLeaf = (leafId) => ({ t: "leaf", id: leafId ?? null });
export const rolloutMeta = (meta) => ({ t: "meta", format: ROLLOUT_FORMAT, ...meta });

/**
 * Read a rollout back. Returns `{ entries, leafId, meta, skipped }` — `skipped`
 * counts lines that could not be parsed, so a caller can tell "nothing was
 * logged" from "the tail was torn".
 *
 * A missing file is not an error: most sessions predate this store.
 */
export function readRollout(id, { dir = null } = {}) {
  const empty = { entries: [], leafId: null, meta: {}, skipped: 0 };
  let text;
  try {
    text = readFileSync(rolloutPath(id, { dir }), "utf8");
  } catch {
    return empty;
  }
  const entries = [];
  let leafId = null;
  let meta = {};
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      skipped += 1; // a torn tail line, almost always the last one
      continue;
    }
    if (rec?.t === "entry" && rec.e && typeof rec.e.id === "string") entries.push(rec.e);
    else if (rec?.t === "leaf") leafId = rec.id ?? null;
    else if (rec?.t === "meta") meta = { ...meta, ...rec };
    else skipped += 1;
  }
  return { entries, leafId, meta, skipped };
}

/**
 * Rebuild a session from the log alone, for when there is no snapshot at all.
 *
 * The case is narrow and real: a session killed during its very first turn never
 * wrote one. Without this the log would hold the whole conversation and the
 * session would still be unresumable, which is insurance that pays out nothing.
 *
 * Returns null when the log has no usable entries — absence stays absence.
 */
export function treeFromRollout(id, { dir = null } = {}) {
  const { entries, leafId, meta } = readRollout(id, { dir });
  if (!entries.length) return null;
  const byId = new Map();
  const kept = [];
  for (const entry of entries) {
    if (byId.has(entry.id)) continue;
    if (entry.parentId != null && !byId.has(entry.parentId)) continue;
    byId.set(entry.id, entry);
    kept.push(entry);
  }
  if (!kept.length) return null;
  return {
    id,
    tree: {
      entries: kept,
      byId,
      leafId: leafId && byId.has(leafId) ? leafId : kept[kept.length - 1].id,
      createdAt: Number.isFinite(meta?.startedAt) ? meta.startedAt : 0,
    },
    // A snapshot carries session meta (rolling summary, checkpoints, plan); the
    // log does not, and inventing it would be worse than starting without it.
    meta: {},
    updatedAt: Number.isFinite(meta?.startedAt) ? meta.startedAt : 0,
    source: "rollout",
  };
}

/**
 * Fold a rollout into a loaded tree: replay the entries the snapshot is missing.
 *
 * Returns `{ tree, replayed }`. The tree is only rebuilt when there is something
 * to replay, so the common case (snapshot newer than the log) costs one lookup
 * per logged entry and allocates nothing.
 *
 * An entry whose parent is unknown is skipped: it belongs to a branch this
 * snapshot does not contain, and grafting it onto the wrong place would invent
 * a conversation that never happened.
 */
export function replayRollout(tree, rollout) {
  const logged = Array.isArray(rollout?.entries) ? rollout.entries : [];
  if (!tree || !logged.length) return { tree, replayed: 0 };
  const byId = new Map(tree.byId ?? []);
  const missing = logged.filter((e) => !byId.has(e.id));
  if (!missing.length) return { tree, replayed: 0 };

  const entries = tree.entries.slice();
  let replayed = 0;
  for (const entry of missing) {
    if (entry.parentId != null && !byId.has(entry.parentId)) continue;
    byId.set(entry.id, entry);
    entries.push(entry);
    replayed += 1;
  }
  if (!replayed) return { tree, replayed: 0 };

  // The logged leaf wins when it names an entry we now hold; otherwise the last
  // replayed entry is the honest cursor.
  const wanted = rollout.leafId;
  const leafId = wanted && byId.has(wanted) ? wanted : entries[entries.length - 1].id;
  return { tree: { ...tree, entries, byId, leafId }, replayed };
}
