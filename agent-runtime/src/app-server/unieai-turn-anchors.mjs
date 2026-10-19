// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-turn-anchors.mjs — which of the engine's turns each client turn is.
 *
 * The client's turns and the engine's are not one to one. uac answers some
 * prompts itself (`/loop` list and stop) without a dsh turn, a `!command`
 * outside a turn gets a client turn of its own, and dsh starts turns on its
 * own (a scheduled turn, a goal round, a subagent waking it) that the client
 * shows as turns while one client turn can also span several dsh turns.
 * Counting turns on either side and mapping by index therefore drifted, and
 * the client's next rewind found a history whose last turn was not the one
 * it knew ("thread history changed").
 *
 * So each client turn records what it began with (`thread.turnMeta[turnId]`):
 *
 *   { anchor: n }            the dsh turn number of its first dsh turn; the
 *                            dsh turns after it that start no client turn
 *                            (a goal round's next round) belong to it too
 *   { anchor: n, prompt }    the same, shown with `prompt` as its user message
 *                            because the model got something else (`/loop 5m`
 *                            sends the loop's instructions; `!` notes)
 *   { local: true, prompt?, reply?, compaction? }
 *                            no dsh turn (a `/loop` answered by uac, a
 *                            `!command`, `/compact`): nothing in the engine's
 *                            history, so what the client was shown is kept
 *
 * An engine with `turnAnchors` reports every dsh turn in `history()`, each
 * with its `anchor`, and counts `keepTurns` in those turns.
 */
import { agentMessageItem, userMessageItem } from "./items.mjs";

/** The turnMeta fields worth keeping, size-capped (they are display text). */
const TEXT_LIMIT = 4000;
const clip = (text) => (typeof text === "string" && text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text);

export function localTurnMeta({ prompt = null, reply = null, compaction = false } = {}) {
  return {
    local: true,
    ...(prompt ? { prompt: clip(prompt) } : {}),
    ...(reply ? { reply: clip(reply) } : {}),
    ...(compaction ? { compaction: true } : {}),
  };
}

export function anchoredTurnMeta(anchor, { prompt = null } = {}) {
  return { anchor, ...(prompt ? { prompt: clip(prompt) } : {}) };
}

/**
 * Line the client's turns up with the engine's.
 *
 * `history` is the engine's turns in order, each `{ anchor, opener, items,
 * status, startedAt, completedAt }`. Returns `entries`, one per client turn
 * in `turnIds` order plus any engine user turn no client turn claims:
 * `{ id, known, from, to, meta }` where `[from, to)` is the range of history
 * turns it covers (`from === to` for a turn with none).
 *
 * Turns from before this bookkeeping (no meta, ahead of the first that has
 * some) are matched to the engine's user-prompted turns in order, which is
 * how they were made.
 */
export function alignTurns({ threadId, turnIds, turnMeta = {}, history }) {
  const position = new Map();
  history.forEach((turn, index) => {
    if (typeof turn.anchor === "number") position.set(turn.anchor, index);
  });
  const claimed = new Set(
    turnIds.map((id) => turnMeta[id]?.anchor).filter((anchor) => typeof anchor === "number" && position.has(anchor)),
  );
  const unclaimedUserTurns = history.filter((turn) => turn.opener === "user" && !claimed.has(turn.anchor));
  // Only the turns before the first one with meta can be from before it:
  // a later turn without any is one whose engine turn has not started yet.
  const firstKnown = turnIds.findIndex((id) => turnMeta[id]);
  const legacy = new Map();
  for (const id of firstKnown < 0 ? turnIds : turnIds.slice(0, firstKnown)) {
    const turn = unclaimedUserTurns.shift();
    if (!turn) break;
    legacy.set(id, turn.anchor);
    claimed.add(turn.anchor);
  }

  // Where each client turn starts in the history, if it has a dsh turn.
  const starts = turnIds.map((id) => {
    const anchor = turnMeta[id]?.anchor ?? legacy.get(id);
    return typeof anchor === "number" && position.has(anchor) ? position.get(anchor) : null;
  });
  // A history turn begins an entry when a client turn claims it, or when it
  // is a user prompt no client turn knows (bookkeeping lost in a crash).
  const begins = new Set(starts.filter((start) => start !== null));
  history.forEach((turn, index) => {
    if (turn.opener === "user" && !claimed.has(turn.anchor)) begins.add(index);
  });
  const nextBegin = (from) => {
    for (let index = from + 1; index < history.length; index += 1) if (begins.has(index)) return index;
    return history.length;
  };

  const entries = [];
  let cursor = 0; // the first history turn not yet placed
  const placeOrphans = (until) => {
    // Unclaimed user turns before `until` become entries of their own.
    for (let index = cursor; index < until; index += 1) {
      if (begins.has(index) && !starts.includes(index)) {
        const anchor = history[index].anchor;
        entries.push({ id: `${threadId}:turn:a${anchor}`, known: false, from: index, to: nextBegin(index), meta: null });
      }
    }
  };
  turnIds.forEach((id, k) => {
    const start = starts[k];
    if (start === null) {
      entries.push({ id, known: true, from: cursor, to: cursor, meta: turnMeta[id] ?? null });
      return;
    }
    placeOrphans(start);
    const to = nextBegin(start);
    entries.push({ id, known: true, from: start, to, meta: turnMeta[id] ?? null });
    cursor = to;
  });
  placeOrphans(history.length);
  return entries;
}

/** The protocol turn for one entry (without its shape wrapper). */
export function entryTurn(entry, history) {
  const covered = history.slice(entry.from, entry.to);
  if (!covered.length) {
    const items = [];
    if (entry.meta?.prompt) items.push(userMessageItem("", entry.meta.prompt));
    if (entry.meta?.reply) items.push(agentMessageItem("", entry.meta.reply));
    if (entry.meta?.compaction) items.push({ type: "contextCompaction", id: "" });
    return { items, status: "completed", startedAt: null, completedAt: null };
  }
  const items = covered.flatMap((turn) => turn.items);
  // The prompt as the client showed it, where the model got something else.
  if (entry.meta?.prompt && !entry.meta.local) {
    const first = items.findIndex((item) => item.type === "userMessage");
    if (first >= 0) items[first] = userMessageItem(items[first].id ?? "", entry.meta.prompt);
  }
  const last = covered.at(-1);
  return { items, status: last.status ?? "completed", startedAt: covered[0].startedAt ?? null, completedAt: last.completedAt ?? null };
}

/**
 * How many history turns to keep so the turn `turnId` and every one after
 * it are gone: where the first of them with a dsh turn starts. Null when
 * none of them has one (nothing to drop on the engine's side), or when
 * `turnId` is not among the entries.
 */
export function keepTurnsBefore(entries, turnId) {
  const position = entries.findIndex((entry) => entry.id === turnId);
  if (position < 0) return null;
  const first = entries.slice(position).find((entry) => entry.to > entry.from);
  return first ? first.from : null;
}
