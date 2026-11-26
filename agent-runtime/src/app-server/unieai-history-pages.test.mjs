// Copyright (c) 2026 UnieAI. All rights reserved.
// Turn and item pages, cut the way the Rust app-server cuts them
// (codex-rs app-server `paginate_thread_turns`), and paging on engines that
// only read whole histories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "./server.mjs";
import { pageItems, pageTurns, summaryItems } from "./unieai-history-pages.mjs";

const ids = ["a", "b", "c", "d", "e"];
const turnsOf = (page) => page.indices.map((index) => ids[index]);

test("turn pages: newest first by default, cursors continue and turn back", () => {
  const first = pageTurns(ids, { limit: 2 });
  assert.deepEqual(turnsOf(first), ["e", "d"]);
  assert.deepEqual(JSON.parse(first.nextCursor), { turnId: "d", includeAnchor: false });
  assert.deepEqual(JSON.parse(first.backwardsCursor), { turnId: "e", includeAnchor: true });
  const second = pageTurns(ids, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(turnsOf(second), ["c", "b"]);
  const last = pageTurns(ids, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(turnsOf(last), ["a"]);
  assert.equal(last.nextCursor, null, "nothing more");
  // The backwards cursor, the other way, includes its anchor.
  assert.deepEqual(turnsOf(pageTurns(ids, { sortDirection: "asc", cursor: second.backwardsCursor })), ["c", "d", "e"]);
  assert.deepEqual(turnsOf(pageTurns(ids, { sortDirection: "asc", limit: 2 })), ["a", "b"]);
  assert.deepEqual(pageTurns([], { limit: 2 }), { indices: [], nextCursor: null, backwardsCursor: null });
  assert.equal(pageTurns(ids, { limit: 0 }).indices.length, 1, "at least one");
  assert.equal(pageTurns(Array.from({ length: 300 }, (_, k) => `t${k}`), { limit: 1000 }).indices.length, 100, "at most 100");
  assert.equal(pageTurns(Array.from({ length: 30 }, (_, k) => `t${k}`)).indices.length, 25, "25 by default");
  assert.throws(() => pageTurns(ids, { cursor: "nope" }), /invalid cursor: nope/);
  assert.throws(() => pageTurns(ids, { cursor: JSON.stringify({ turnId: "z", includeAnchor: true }) }), /anchor turn is no longer present/);
});

test("item pages: oldest first by default, across turns or within one, by cursor or item anchor", () => {
  const turns = [
    { id: "a", itemCount: 2 },
    { id: "b", itemCount: 0 },
    { id: "c", itemCount: 3 },
  ];
  const idsOf = (page) => page.positions.map(({ turn, item }) => `${turns[turn].id}:item:${item}`);
  assert.deepEqual(idsOf(pageItems(turns)), ["a:item:0", "a:item:1", "c:item:0", "c:item:1", "c:item:2"]);
  const newest = pageItems(turns, { sortDirection: "desc", limit: 2 });
  assert.deepEqual(idsOf(newest), ["c:item:2", "c:item:1"]);
  assert.deepEqual(idsOf(pageItems(turns, { sortDirection: "desc", limit: 2, cursor: newest.nextCursor })), ["c:item:0", "a:item:1"]);
  assert.deepEqual(idsOf(pageItems(turns, { cursor: newest.backwardsCursor })), ["c:item:2"], "turning back includes the anchor");
  assert.deepEqual(idsOf(pageItems(turns, { turnId: "c", cursor: { type: "item", itemId: "c:item:0" } })), ["c:item:1", "c:item:2"]);
  assert.deepEqual(idsOf(pageItems(turns, { turnId: "c", sortDirection: "desc", cursor: { type: "item", itemId: "c:item:2" } })), ["c:item:1", "c:item:0"]);
  assert.throws(() => pageItems(turns, { cursor: { type: "item", itemId: "c:item:0" } }), /turnId is required/);
  assert.throws(() => pageItems(turns, { turnId: "a", cursor: { type: "item", itemId: "c:item:0" } }), /no longer present/);
  assert.deepEqual(pageItems(turns, { turnId: "missing" }).positions, []);
  // Turns read in full name their items by their own ids.
  assert.deepEqual(idsOf(pageItems([{ id: "x", itemCount: 2, itemIds: ["p", "q"] }], { cursor: { type: "item", itemId: "p" }, turnId: "x" })).length, 1);
});

test("a summary is the first user message and the last answer", () => {
  const user = (id) => ({ type: "userMessage", id, content: [] });
  const agent = (id) => ({ type: "agentMessage", id, text: id });
  assert.deepEqual(summaryItems([user("u1"), agent("a1"), { type: "reasoning", id: "r" }, user("u2"), agent("a2")]), [user("u1"), agent("a2")]);
  assert.deepEqual(summaryItems([agent("a1")]), [agent("a1")]);
  assert.deepEqual(summaryItems([{ type: "reasoning", id: "r" }]), []);
});

test("an engine without anchored history pages too, with item ids that hold across reads; resume can leave the turns out", async () => {
  const h = createHandlers({
    createEngineFor: () => ({
      send: async () => {},
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  assert.equal(thread.historyMode, "paginated");
  await h["turn/start"]({ threadId: thread.id, input: "go" }, { emit: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  const first = await h["thread/items/list"]({ threadId: thread.id, limit: 2, sortDirection: "desc" });
  const rest = await h["thread/items/list"]({ threadId: thread.id, limit: 2, sortDirection: "desc", cursor: first.nextCursor });
  assert.deepEqual([...first.data, ...rest.data].map((entry) => entry.item.type), ["userMessage", "agentMessage", "userMessage"]);
  assert.equal(rest.nextCursor, null);
  const { data: [turn] } = await h["thread/turns/list"]({ threadId: thread.id });
  assert.equal(turn.itemsView, "summary");
  assert.deepEqual(turn.items.map((item) => item.type), ["userMessage", "agentMessage"]);
  const resumed = await h["thread/resume"]({ threadId: thread.id, excludeTurns: true });
  assert.deepEqual(resumed.thread.turns, []);
  assert.equal((await h["thread/resume"]({ threadId: thread.id })).thread.turns.length, 1, "without excludeTurns, every turn");
  const withPage = await h["thread/resume"]({ threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 1, itemsView: "notLoaded" } });
  assert.deepEqual(withPage.initialTurnsPage.data.map((t) => [t.id, t.itemsView]), [[turn.id, "notLoaded"]]);
});
