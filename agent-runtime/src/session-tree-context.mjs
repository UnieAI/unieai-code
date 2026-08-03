/**
 * session-tree-context.mjs — deriving a UnieAI Code prompt from a session tree.
 *
 * `third_party/unieai-agent-core/src/session-tree.mjs` owns the data model and
 * `session-tree-store.mjs` owns the file. This is the third piece, and it lives
 * here because both of those would have to know what a UnieAI Code prompt looks
 * like to provide it:
 *
 *   · THE SYSTEM PREFIX SURVIVES COMPACTION. The core rule drops everything
 *     before a compaction entry, and the system prompt is the first entry of
 *     every session — applied literally, the first fold would send a prompt with
 *     no system message at all, i.e. an agent with no tools guidance and no
 *     identity. `compactWithSummary` already draws exactly this line for arrays
 *     (`leadingSystemCount`); this draws the same one over entries, so the
 *     derived context matches what the array path produced message for message.
 *
 *   · CHECKPOINTS KEY ON AN ENTRY, NOT ON A MESSAGE COUNT. A message index is
 *     invalidated by every fold — the old engine had to renumber its checkpoints
 *     against the geometry of each splice. An entry id is stable forever, so the
 *     index is DERIVED here on demand instead of being maintained, and there is
 *     nothing left to renumber.
 *
 * Pure and IO-free, like the core module it builds on.
 */

import {
  ENTRY_TYPES,
  append,
  applyCompaction,
  currentPath,
} from "../../third_party/unieai-agent-core/src/session-tree.mjs";

/**
 * The role a folded summary re-enters the prompt as.
 *
 * `user`, matching `compactWithSummary`: a system message would be pinned ahead
 * of the real system prompt by the prefix rule above, and the summary belongs in
 * the conversation where the turns it replaced were.
 */
const SUMMARY_ROLE = "user";

/** The message an entry contributes to the prompt, or null when it contributes none. */
export function messageOfEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === ENTRY_TYPES.MESSAGE && entry.message) return entry.message;
  if (entry.type === ENTRY_TYPES.COMPACTION && entry.summary) return { role: SUMMARY_ROLE, content: entry.summary };
  if (entry.type === ENTRY_TYPES.BRANCH_SUMMARY && entry.summary) return { role: SUMMARY_ROLE, content: entry.summary };
  return null;
}

/**
 * The leading run of system messages on a path — the part a fold must keep.
 *
 * Counted over MESSAGES, not entries: a `state_change` in front of the system
 * prompt (which is exactly what a migrated legacy session has) contributes no
 * message and must not end the run before it starts.
 */
function leadingSystemEntries(path) {
  const out = [];
  for (const entry of path) {
    const message = messageOfEntry(entry);
    if (!message) continue;
    if (message.role !== "system") break;
    out.push(entry);
  }
  return out;
}

/**
 * The prompt for a tree: the messages to send and the entry each one came from.
 *
 * `entryIds` is parallel to `messages`, which is what lets a caller name a
 * position in the prompt by something that survives the next fold.
 */
export function deriveEngineContext(tree) {
  const path = currentPath(tree);
  const compacted = applyCompaction(path);

  let effective = compacted;
  if (compacted.length !== path.length) {
    const live = new Set(compacted.map((e) => e.id));
    const kept = leadingSystemEntries(path).filter((e) => !live.has(e.id));
    if (kept.length) effective = [...kept, ...compacted];
  }

  const messages = [];
  const entryIds = [];
  for (const entry of effective) {
    const message = messageOfEntry(entry);
    if (!message) continue;
    messages.push(message);
    entryIds.push(entry.id);
  }
  return { messages, entryIds, effective, path };
}

/**
 * Entries on the path that the prompt no longer carries — what a fold dropped.
 *
 * The core's `foldedAway` answers the same question against the core's rule, so
 * it reports the system prefix as folded; this one answers it against the rule
 * the engine actually derives with.
 */
export function foldedEntries(tree) {
  const { path, effective } = deriveEngineContext(tree);
  const live = new Set(effective.map((e) => e.id));
  return path.filter((e) => !live.has(e.id));
}

/**
 * Where an entry sits in the CURRENT prompt, as the message count the array-based
 * engine would have recorded (i.e. `messages.length` just after that entry).
 *
 * A folded-away entry no longer has a position of its own; it reports the slot
 * just after the summary that replaced it, which is where the old engine clamped
 * a checkpoint whose span had been folded. An entry that is not on the path at
 * all (a different branch, or a checkpoint carried over from a legacy file whose
 * index no longer resolves) reports `fallback` rather than a made-up number.
 */
export function messageIndexFor(tree, entryId, { fallback = 0 } = {}) {
  if (!entryId) return fallback;
  const { messages, entryIds, path } = deriveEngineContext(tree);
  const at = entryIds.lastIndexOf(entryId);
  if (at >= 0) return at + 1;
  if (!path.some((e) => e.id === entryId)) return fallback;
  let systemCount = 0;
  while (systemCount < messages.length && messages[systemCount]?.role === "system") systemCount += 1;
  return Math.min(messages.length, systemCount + 1);
}

/**
 * Hand out entry ids that cannot collide with the ones already in the tree.
 *
 * A resumed session brings its own id space (`m0…` from a legacy migration,
 * `n1…` from a previous run of this factory). Reusing one of those ids would not
 * fail loudly — `append` would overwrite the entry in `byId` and re-parent an
 * arbitrary stretch of history — so the taken set is seeded from the tree and
 * grows with every id issued.
 */
export function makeEntryIdFactory(tree, { prefix = "n" } = {}) {
  const taken = new Set(tree?.byId ? tree.byId.keys() : []);
  let n = 0;
  return function nextEntryId() {
    let id;
    do {
      n += 1;
      id = `${prefix}${n}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
}

/** Append messages as one entry each, in order. Returns the new tree and their ids. */
export function appendMessages(tree, messages, { nextId, now = Date.now() } = {}) {
  let next = tree;
  const ids = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const id = nextId();
    next = append(next, { type: ENTRY_TYPES.MESSAGE, message }, { id, now });
    ids.push(id);
  }
  return { tree: next, ids };
}

/**
 * Record a `compactWithSummary` result as a compaction ENTRY.
 *
 * The array path replaced the history with `[...system, summary, ...recent]`.
 * The tree records the same decision without deleting anything: one entry
 * carrying the summary, pointing at the first message the fold KEPT
 * (`firstKeptId`), so `applyCompaction` yields `[summary, ...recent]` and the
 * prefix rule in `deriveEngineContext` puts the system messages back in front.
 * The folded originals stay on the path — `foldedEntries` still reaches them.
 *
 * `entryIds` must be parallel to the array that was handed to
 * `compactWithSummary`; the fold's geometry (`systemCount`, `foldedCount`) is
 * expressed in indices into that array, and this is what turns them back into
 * entry ids.
 *
 * The entry stores the summary MESSAGE's content rather than the raw summary
 * text, so the core's own `deriveContext` renders the same prompt this module
 * does — the tag wrapper is part of what the model reads (`realUserTask` skips
 * `<conversation_summary>` blocks by that wrapper). The raw text rides along as
 * `summaryText` because that, not the wrapper, is what the next fold merges.
 *
 * Returns `applied: false` and the tree untouched when there is nothing to
 * record, so a caller can leave its rolling summary alone as well.
 */
export function appendFold(tree, { folded, entryIds = [], nextId, now = Date.now() } = {}) {
  if (!folded?.changed) return { tree, applied: false, entryId: null };
  const systemCount = Number.isFinite(folded.systemCount) ? folded.systemCount : 0;
  const foldedCount = Number.isFinite(folded.foldedCount) ? folded.foldedCount : 0;
  const summaryMessage = Array.isArray(folded.messages) ? folded.messages[systemCount] : null;
  const content = summaryMessage?.content;
  // A shape we do not recognise means we cannot say which entries the fold kept.
  // Refusing is fail-open: the history stays whole and the mechanical per-request
  // path still bounds the next prompt.
  if (typeof content !== "string" || !content) return { tree, applied: false, entryId: null };

  const firstKeptId = entryIds[systemCount + foldedCount] ?? null;
  const id = nextId();
  const entry = { type: ENTRY_TYPES.COMPACTION, summary: content, summaryText: String(folded.summary || "") };
  if (firstKeptId) entry.firstKeptId = firstKeptId;
  return { tree: append(tree, entry, { id, now }), applied: true, entryId: id };
}
