/**
 * session-tree-store.mjs — persistence for the append-only session tree.
 *
 * `third_party/unieai-agent-core/src/session-tree.mjs` models a session as a
 * tree of entries whose prompt is DERIVED by walking root → leaf. It is pure and
 * never touches disk; this module is the IO half, in the same split the core
 * uses for vision (`vision.mjs` pure, `vision-store.mjs` on disk).
 *
 * Two things drive every decision here.
 *
 * 1. `byId` is a `Map`. `JSON.stringify` turns a Map into `{}`, so a naive round
 *    trip would load a tree whose entries are all unreachable — `deriveContext`
 *    would return zero messages and the session would look empty while the file
 *    still held every word of it. `byId` is therefore NOT serialized at all: it
 *    is an index over `entries`, and it is rebuilt from `entries` on load. One
 *    source of truth on disk means the index cannot drift out of agreement with
 *    the thing it indexes.
 *
 * 2. The ~14 session files already on disk are real user data written by
 *    `session.mjs` in the legacy `{id, model, cwd, updatedAt, messages}` shape,
 *    and `session.mjs`/`engine.mjs` still read and write them. Migration here is
 *    READ-ONLY (see `loadSessionTree`): a legacy file is converted in memory and
 *    left byte-for-byte alone on disk, and tree files are written to a SEPARATE
 *    directory. Nothing this module does can damage a legacy session.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";
import { ENTRY_TYPES, append, createTree } from "../../third_party/unieai-agent-core/src/session-tree.mjs";

/**
 * The tag that makes shape detection a lookup rather than a guess.
 *
 * A legacy file never carries `format`, and an envelope written here never
 * carries a top-level `messages` array, so no file can satisfy both tests.
 */
export const SESSION_TREE_FORMAT = "unieai.session-tree";
export const SESSION_TREE_VERSION = 1;

const TREE_DIR_NAME = "agent-session-trees";
const LEGACY_DIR_NAME = "agent-sessions";

/** Legacy keys that are represented elsewhere in the tree, so not in `meta`. */
const LEGACY_KEYS_HANDLED = new Set(["id", "model", "cwd", "updatedAt", "messages"]);

/** Same sanitising as `session.mjs`, so an id names the same file in both stores. */
function safeId(id) {
  return String(id).replace(/[^\w.-]/g, "");
}

/** Where tree files live. Created on demand, like the other UNIEAI_HOME stores. */
export function sessionTreesDir() {
  const dir = join(unieaiHome(), TREE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Where `session.mjs` keeps legacy sessions.
 *
 * Deliberately does not create the directory: this module only ever reads from
 * it, and creating it would be the first step toward writing to it.
 */
export function legacySessionsDir() {
  return join(unieaiHome(), LEGACY_DIR_NAME);
}

export function treePath(id, { dir = null } = {}) {
  return join(dir ?? sessionTreesDir(), `${safeId(id)}.json`);
}

export function legacyPath(id, { dir = null } = {}) {
  return join(dir ?? legacySessionsDir(), `${safeId(id)}.json`);
}

/**
 * Which shape is this parsed JSON in?
 *
 * The format tag decides, and it decides alone — a file tagged as a tree is
 * read as a tree even if it is malformed, so a damaged tree can never be
 * mistaken for a legacy session (and then "migrated", which would fabricate a
 * conversation out of whatever `messages` happened to be lying around).
 * Structural validation is `deserializeTree`'s job and reports precisely.
 */
export function detectShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unknown";
  if (parsed.format === SESSION_TREE_FORMAT) return "tree";
  if (Array.isArray(parsed.messages)) return "legacy";
  return "unknown";
}

/**
 * Convert a legacy `{messages: [...]}` session into a tree, in memory.
 *
 * The messages become one `message` entry each, in order, in a straight line —
 * so `deriveContext(tree).messages` is exactly the array `loadSession` would
 * have returned, which is the property that makes adoption safe. Everything
 * else the legacy file carried is preserved rather than curated:
 *
 *   · `model` and `cwd` become a leading `state_change`, which is where the
 *     tree model keeps state, and is honest history: a legacy file records one
 *     model for the whole session.
 *   · Every other key (`summary`, `contextEpoch`, `checkpoints`, `plan`, and
 *     anything a future writer adds) is copied verbatim into `meta`. A store
 *     that silently drops fields it does not recognise is how resume state gets
 *     lost, so the pass-through is by key exclusion, not by allow-list.
 *
 * The rolling `summary` is deliberately NOT turned into a `compaction` entry.
 * `compactWithSummary` has already folded it into the `messages` array as a
 * system message; a compaction entry would additionally drop everything before
 * it from the derived prompt, silently shortening a resumed conversation.
 *
 * Entry ids are deterministic (`m0`, `m1`, …), so converting the same file
 * twice yields an identical tree — an accidental double migration cannot fork
 * a session into two id spaces.
 */
export function treeFromLegacy(legacy) {
  const messages = Array.isArray(legacy?.messages) ? legacy.messages : [];
  // Legacy files hold no per-message timestamps, so entries are stamped with
  // the file's own `updatedAt` rather than with invented per-entry times.
  const at = Number.isFinite(legacy?.updatedAt) ? legacy.updatedAt : 0;

  let tree = createTree({ now: at });
  if (legacy?.model != null || legacy?.cwd != null) {
    tree = append(
      tree,
      { type: ENTRY_TYPES.STATE_CHANGE, patch: { model: legacy.model ?? "", cwd: legacy.cwd ?? "" } },
      { id: "s0", now: at }
    );
  }
  messages.forEach((message, i) => {
    tree = append(tree, { type: ENTRY_TYPES.MESSAGE, message }, { id: `m${i}`, now: at });
  });

  const meta = {};
  for (const [key, value] of Object.entries(legacy ?? {})) {
    if (!LEGACY_KEYS_HANDLED.has(key)) meta[key] = value;
  }

  return { id: legacy?.id ?? null, tree, meta, updatedAt: at };
}

/**
 * The on-disk envelope. `byId` is omitted on purpose — see the header.
 *
 * `meta` is stored as given: this store does not decide which session fields
 * matter.
 */
export function serializeTree({ id, tree, meta = {}, updatedAt = Date.now() }) {
  return {
    format: SESSION_TREE_FORMAT,
    version: SESSION_TREE_VERSION,
    id: id ?? null,
    updatedAt,
    createdAt: tree?.createdAt ?? 0,
    leafId: tree?.leafId ?? null,
    meta: meta ?? {},
    entries: Array.isArray(tree?.entries) ? tree.entries : [],
  };
}

/**
 * Rebuild a tree from an envelope, restoring the `byId` Map from `entries`.
 *
 * The repair policy, applied uniformly: fix what can be fixed without inventing
 * content, refuse what cannot.
 *
 *   · A `leafId` naming an entry that is not present loses only the cursor, not
 *     the history, so it falls back to the last entry — every entry survives and
 *     the session resumes at its end. Throwing would strand a readable session.
 *   · An entry with no id cannot be repaired: its children point at nothing, so
 *     any "fix" would be a guess at the conversation's structure. That throws.
 *
 * A newer `version` also throws, rather than being read with the fields this
 * build understands and then saved back without the ones it does not.
 */
export function deserializeTree(envelope) {
  if (detectShape(envelope) !== "tree") {
    throw new Error("not a session tree file");
  }
  const version = Number(envelope.version);
  if (!Number.isFinite(version) || version > SESSION_TREE_VERSION) {
    throw new Error(`session tree version ${envelope.version} is newer than this build understands (${SESSION_TREE_VERSION})`);
  }
  if (!Array.isArray(envelope.entries)) {
    throw new Error("session tree file has no entries array");
  }

  const byId = new Map();
  for (const entry of envelope.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new Error("session tree file has an entry without an id");
    }
    byId.set(entry.id, entry);
  }

  const stored = envelope.leafId ?? null;
  const leafId = stored === null || byId.has(stored)
    ? stored
    : (envelope.entries.length ? envelope.entries[envelope.entries.length - 1].id : null);

  return {
    id: envelope.id ?? null,
    tree: {
      entries: envelope.entries.slice(),
      byId,
      leafId,
      createdAt: Number.isFinite(envelope.createdAt) ? envelope.createdAt : 0,
    },
    meta: envelope.meta && typeof envelope.meta === "object" ? envelope.meta : {},
    updatedAt: Number.isFinite(envelope.updatedAt) ? envelope.updatedAt : 0,
    // True when the file's cursor was dangling and the tail was used instead.
    leafRepaired: stored !== leafId,
  };
}

/**
 * Write a tree, and only ever into the tree directory.
 *
 * Rename-into-place so a crash mid-write leaves the previous session intact
 * instead of a truncated JSON file: a session is worth more than the one write
 * that would be lost.
 */
export function saveSessionTree({ id, tree, meta = {}, dir = null, now = Date.now() }) {
  const target = dir ?? sessionTreesDir();
  mkdirSync(target, { recursive: true });
  const path = join(target, `${safeId(id)}.json`);
  const body = `${JSON.stringify(serializeTree({ id, tree, meta, updatedAt: now }), null, 0)}\n`;
  const tmp = `${path}.${process.pid.toString(36)}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
  return path;
}

/** Read one file and return it in tree form, whichever shape it is stored in. */
function readAt(path, source) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    // Damage is not absence. Returning an empty tree would let the next save
    // overwrite a file whose contents we merely failed to parse, turning a
    // recoverable problem into a permanent one.
    throw new Error(`session file at ${path} is unreadable: ${err.message}`);
  }
  const shape = detectShape(parsed);
  if (shape === "tree") return { ...deserializeTree(parsed), source, path, migrated: false };
  if (shape === "legacy") return { ...treeFromLegacy(parsed), source, path, migrated: true, leafRepaired: false };
  throw new Error(`session file at ${path} is neither a session tree nor a legacy session`);
}

/**
 * Load a session as a tree, from either store.
 *
 * The tree file wins when one exists; otherwise the legacy file is converted on
 * READ and left untouched. Nothing is ever rewritten in place, because
 * `session.mjs` and `engine.mjs` are still reading these files: a legacy file
 * rewritten into tree shape would parse fine for the legacy loader and then
 * yield `messages === undefined`, i.e. an empty conversation and a blank row in
 * the session picker, with the original gone. Converting on read costs one pass
 * over an array we already parsed, and it is idempotent, so the price of being
 * non-destructive is nil. Rolling back adoption is then just ignoring
 * `agent-session-trees/`.
 *
 * Returns null when the session does not exist in either store; throws when a
 * file exists but cannot be understood.
 */
export function loadSessionTree(id, { dir = null, legacyDir = null } = {}) {
  const fromTree = readAt(join(dir ?? sessionTreesDir(), `${safeId(id)}.json`), "tree");
  if (fromTree) return fromTree;
  return readAt(join(legacyDir ?? legacySessionsDir(), `${safeId(id)}.json`), "legacy");
}
