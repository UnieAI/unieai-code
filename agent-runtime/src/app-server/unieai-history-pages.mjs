// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-history-pages.mjs — `thread/turns/list` and `thread/items/list`
 * pages, the way the Rust app-server cuts them.
 *
 * A thread with `historyMode: "paginated"` is hydrated by the client in
 * pages: the last few turns without their items, then items newest first
 * until the screen is full. Serving that from a full history read sent a
 * long conversation's every tool output (tens of megabytes) to show its last
 * screen. These functions decide which turns and items a page holds from the
 * turns' ids and item counts alone, so the caller loads only those.
 *
 * Cursors are opaque to the client. Turn cursors are the Rust legacy
 * server's (`{"turnId","includeAnchor"}`, codex-rs app-server
 * `paginate_thread_turns`); item cursors are the same shape over item ids.
 * `nextCursor` continues after the page's last entry; `backwardsCursor`,
 * used with the opposite `sortDirection`, starts at its first one again.
 */
import { RpcError, RPC } from "./rpc.mjs";

export const TURNS_DEFAULT_LIMIT = 25;
export const TURNS_MAX_LIMIT = 100;
export const ITEMS_DEFAULT_LIMIT = 25;
export const ITEMS_MAX_LIMIT = 100;

const pageSize = (limit, fallback, max) => {
  const value = limit === null || limit === undefined ? fallback : Number(limit);
  return Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value) : fallback, max));
};

const parseCursor = (cursor, key) => {
  let parsed = null;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    // Reported below.
  }
  if (!parsed || typeof parsed[key] !== "string" || typeof parsed.includeAnchor !== "boolean") {
    throw new RpcError(RPC.INVALID_REQUEST, `invalid cursor: ${cursor}`);
  }
  return parsed;
};

/** The id an item has at position `index` of turn `turnId`, in every read. */
export const itemIdAt = (turnId, index) => `${turnId}:item:${index}`;

/**
 * One page of turns: `{ indices, nextCursor, backwardsCursor }`, `indices`
 * into `ids` in page order. `sortDirection` defaults to descending.
 */
export function pageTurns(ids, { cursor = null, limit = null, sortDirection = null } = {}) {
  if (!ids.length) return { indices: [], nextCursor: null, backwardsCursor: null };
  const anchor = cursor === null || cursor === undefined ? null : parseCursor(cursor, "turnId");
  const size = pageSize(limit, TURNS_DEFAULT_LIMIT, TURNS_MAX_LIMIT);
  const anchorIndex = anchor ? ids.indexOf(anchor.turnId) : -1;
  if (anchor && anchorIndex < 0) throw new RpcError(RPC.INVALID_REQUEST, "invalid cursor: anchor turn is no longer present");
  let order = ids.map((_, index) => index);
  if (sortDirection === "asc") {
    if (anchor) order = order.filter((index) => (anchor.includeAnchor ? index >= anchorIndex : index > anchorIndex));
  } else {
    order.reverse();
    if (anchor) order = order.filter((index) => (anchor.includeAnchor ? index <= anchorIndex : index < anchorIndex));
  }
  const more = order.length > size;
  const indices = order.slice(0, size);
  const cursorAt = (index, includeAnchor) => JSON.stringify({ turnId: ids[index], includeAnchor });
  return {
    indices,
    nextCursor: more && indices.length ? cursorAt(indices.at(-1), false) : null,
    backwardsCursor: indices.length ? cursorAt(indices[0], true) : null,
  };
}

/**
 * One page of items across `turns` (`[{ id, itemCount, itemIds? }]`, in thread order):
 * `{ positions: [{ turn, item }], nextCursor, backwardsCursor }`, positions
 * in page order. `turnId` keeps to one turn; `cursor` is a returned cursor
 * or an item anchor (`{type: "item", itemId}`, exclusive, `turnId` required).
 * `sortDirection` defaults to ascending.
 */
export function pageItems(turns, { turnId = null, cursor = null, limit = null, sortDirection = null } = {}) {
  const isAnchor = cursor !== null && typeof cursor === "object";
  if (isAnchor && (cursor.type !== "item" || typeof cursor.itemId !== "string")) {
    throw new RpcError(RPC.INVALID_PARAMS, "invalid cursor: expected an item anchor");
  }
  if (isAnchor && !turnId) throw new RpcError(RPC.INVALID_PARAMS, "turnId is required when cursor is an item anchor");
  const anchor = cursor === null || cursor === undefined ? null : isAnchor ? { itemId: cursor.itemId, includeAnchor: false } : parseCursor(cursor, "itemId");
  const size = pageSize(limit, ITEMS_DEFAULT_LIMIT, ITEMS_MAX_LIMIT);
  // Every item of the requested turns, in thread order.
  const all = [];
  turns.forEach((turn, index) => {
    if (turnId && turn.id !== turnId) return;
    for (let item = 0; item < turn.itemCount; item += 1) all.push({ turn: index, item });
  });
  // Turns read in full carry their items' ids; the rest have them by position.
  const idOf = (position) => turns[position.turn].itemIds?.[position.item] ?? itemIdAt(turns[position.turn].id, position.item);
  let anchorIndex = -1;
  if (anchor) {
    anchorIndex = all.findIndex((position) => idOf(position) === anchor.itemId);
    if (anchorIndex < 0) {
      throw new RpcError(isAnchor ? RPC.INVALID_PARAMS : RPC.INVALID_REQUEST, "invalid cursor: anchor item is no longer present");
    }
  }
  let order = all.map((_, index) => index);
  if (sortDirection === "desc") {
    order.reverse();
    if (anchor) order = order.filter((index) => (anchor.includeAnchor ? index <= anchorIndex : index < anchorIndex));
  } else if (anchor) {
    order = order.filter((index) => (anchor.includeAnchor ? index >= anchorIndex : index > anchorIndex));
  }
  const more = order.length > size;
  const positions = order.slice(0, size).map((index) => all[index]);
  const cursorAt = (position, includeAnchor) => JSON.stringify({ itemId: idOf(position), includeAnchor });
  return {
    positions,
    nextCursor: more && positions.length ? cursorAt(positions.at(-1), false) : null,
    backwardsCursor: positions.length ? cursorAt(positions[0], true) : null,
  };
}

/**
 * A turn's items as `itemsView: "summary"` shows them: its first user
 * message and its last agent message (codex `TurnItemsView::project_items`).
 */
export function summaryItems(items) {
  const user = items.find((item) => item.type === "userMessage");
  const agent = items.findLast((item) => item.type === "agentMessage");
  if (user && agent && user.id !== agent.id) return [user, agent];
  if (user) return [user];
  return agent ? [agent] : [];
}
