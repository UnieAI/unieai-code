// Copyright (c) 2026 UnieAI. All rights reserved.
// Client turns line up with the engine's when they are not one to one:
// `/loop` list and stop answered without a rabi turn, scheduled turns and goal
// rounds rabi starts on its own, a `!command` turn. The engine here keeps a rabi
// event log and reads it with the real unieai-control functions, so history,
// rewind and fork go through the same code as uac's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers } from "./server.mjs";
import { createThreadStore } from "./unieai-thread-store.mjs";
import { alignTurns, keepTurnsBefore } from "./unieai-turn-anchors.mjs";
import { userMessageItem } from "./items.mjs";
import { forkCut, historyAnswer, historyFromEvents, rewindRequest } from "../unieai-rabi/unieai-control.mjs";
import { historyRangeTurn, historyTurn } from "../unieai-rabi/engine.mjs";
import { summaryItems } from "./unieai-history-pages.mjs";

/**
 * A rabi session log per conversation; `/loop` handled as unieai-schedule does.
 * `ranged`: the engine also reads ranges of turns (`historyRange`, as uac's
 * does through unieai-control), so the server pages without full reads.
 */
function rabiWorld({ ranged = false } = {}) {
  const options = { ranged };
  const sessions = new Map(); // id -> events
  const calls = [];
  const reads = []; // historyRange's ranges, in order
  let nextSession = 1;
  let hooks = null;
  let engineRef = null;
  const factory = (callbacks) => {
    hooks = callbacks;
    let id = callbacks.resumeState?.id ?? null;
    const events = () => sessions.get(id);
    const ensure = () => {
      if (id) return;
      id = `s${nextSession++}`;
      sessions.set(id, []);
      callbacks.onState({ id });
    };
    const append = (type, data) => events().push({ type, seq: events().length, time: Date.now(), data });
    const lastTurn = () => events().findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
    const runTurn = (source, text) => {
      const turn = lastTurn() + 1;
      append("turn/start", { turn });
      append("user/message", { content: [{ type: "text", text }], source });
      append("tool/call", { callId: `c${turn}`, name: "edit", arguments: "{}" });
      append("tool/result", { message: { role: "tool", toolCallId: `c${turn}`, content: [{ type: "text", text: `edited ${turn}` }], isError: false } });
      append("assistant/message", { message: { content: [{ type: "text", text: `done: ${text}` }] } });
      append("turn/end", { turn, reason: { kind: "completed" } });
      return turn;
    };
    const engine = {
      turnAnchors: true,
      async send(text, { onTurn } = {}) {
        ensure();
        if (text === "/loop" || text === "/loop stop") return { stopReason: "end_turn", reply: `${text}: nothing scheduled` };
        const loop = /^\/loop \S+ (.*)$/.exec(text);
        const sent = loop ? `<loop every="1m">\n${loop[1]}` : text;
        const turn = lastTurn() + 1;
        append("turn/start", { turn });
        onTurn?.({ turn, rewritten: sent !== text });
        events().pop();
        runTurn({ kind: "user" }, sent);
        return { stopReason: "end_turn" };
      },
      async history() {
        if (!id) return [];
        return historyFromEvents(events(), { everyTurn: true }).map((turn) => ({ ...historyTurn(turn), anchor: turn.rabiTurn, opener: turn.opener }));
      },
      ...(options.ranged
        ? {
            async historyRange({ from = 0, to = null } = {}) {
              reads.push([from, to]);
              if (!id) return { version: "empty", turns: [] };
              const turns = historyFromEvents(events(), { everyTurn: true });
              return { version: `v${events().length}`, turns: historyAnswer(turns, { from, to }).turns.map(historyRangeTurn) };
            },
          }
        : {}),
      async revertPreview({ keepTurns }) {
        calls.push(["preview", keepTurns]);
        const request = rewindRequest({ events: events() }, keepTurns, { everyTurn: true });
        return { available: true, files: request ? [{ path: `from-${request.fromSeq}`, change: "modify" }] : [] };
      },
      async revert({ keepTurns, restoreFiles }) {
        calls.push(["revert", keepTurns, restoreFiles]);
        const cut = forkCut(events(), keepTurns, { everyTurn: true });
        const child = `s${nextSession++}`;
        sessions.set(child, events().slice(0, cut));
        id = child;
        callbacks.onState({ id });
        return { restored: null };
      },
      async fork({ keepTurns }) {
        calls.push(["fork", keepTurns]);
        const all = historyFromEvents(events(), { everyTurn: true }).length;
        const cut = forkCut(events(), keepTurns ?? all, { everyTurn: true });
        const child = `s${nextSession++}`;
        sessions.set(child, events().slice(0, cut));
        return { state: { id: child }, keptTurns: keepTurns ?? all };
      },
      async compact() {
        return true;
      },
      async close() {},
    };
    engineRef = { engine, runTurn };
    return engine;
  };
  return {
    factory,
    options,
    calls,
    reads,
    sessions,
    // rabi runs a scheduled turn on its own: the bridge's notes, in order.
    scheduledTick(text) {
      const turn = engineRef.runTurn({ kind: "unieai-schedule", summary: text }, `<scheduled>${text}`);
      hooks.onEngineTurn({ phase: "start", turn });
      hooks.onScheduledPrompt(text);
      hooks.onEngineTurn({ phase: "end", reason: "completed" });
    },
    goalRounds(count) {
      const first = engineRef.runTurn({ kind: "goal" }, "continue");
      hooks.onEngineTurn({ phase: "start", turn: first });
      for (let round = 1; round < count; round += 1) engineRef.runTurn({ kind: "goal" }, "continue");
      hooks.onEngineTurn({ phase: "end", reason: "completed" });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "uac-anchors-"));
  const world = rabiWorld(options);
  const store = createThreadStore(join(dir, "threads.json"));
  const make = () => createHandlers({ createEngineFor: world.factory, codexHome: dir, threadStore: store });
  const emitted = [];
  const ctx = { emit: (method, params) => emitted.push([method, params]), request: async () => ({}) };
  return { make, ctx, emitted, world };
}

async function turn(h, ctx, threadId, text) {
  const { turn: started } = await h["turn/start"]({ threadId, input: text }, ctx);
  await settle();
  return started.id;
}

/** A scenario, run against an engine that reads whole histories and one that reads ranges. */
function scenario(name, run) {
  test(name, () => run({}));
  test(`${name} (ranged reads)`, () => run({ ranged: true }));
}

const lastStartedTurn = (emitted) => emitted.filter(([method]) => method === "turn/started").at(-1)[1].turn.id;

/** What the TUI checks before a rewind, and the prompts it counts. */
async function readAsTui(h, ctx, threadId) {
  const { thread } = await h["thread/read"]({ threadId, includeTurns: true }, ctx);
  const prompts = thread.turns.flatMap((t) => t.items.filter((i) => i.type === "userMessage").map((i) => i.content[0].text));
  return { ids: thread.turns.map((t) => t.id), last: thread.turns.at(-1)?.id ?? null, prompts };
}

scenario("/loop list and stop leave rewinding to the turns around them working", async (options) => {
  const { make, ctx, emitted, world } = setup(options);
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await turn(h, ctx, thread.id, "edit one");
  const list = await turn(h, ctx, thread.id, "/loop");
  const stop = await turn(h, ctx, thread.id, "/loop stop");
  const t2 = await turn(h, ctx, thread.id, "edit two");

  const read = await readAsTui(h, ctx, thread.id);
  assert.equal(read.last, lastStartedTurn(emitted), "the history ends at the turn the client last saw");
  assert.deepEqual(read.ids, [t1, list, stop, t2]);
  assert.deepEqual(read.prompts, ["edit one", "/loop", "/loop stop", "edit two"], "every prompt the client showed, in order");
  const { thread: full } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.equal(full.turns[1].items[1].text, "/loop: nothing scheduled", "the local answer is kept");

  const preview = await h["thread/revert/preview"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  assert.equal(preview.files.length, 1, "turn 2's edits can be put back");
  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: t2, restoreFiles: true }, ctx);
  assert.deepEqual(world.calls.slice(-2), [["preview", 1], ["revert", 1, true]], "rabi keeps its one turn");
  const after = await readAsTui(h, ctx, thread.id);
  assert.deepEqual(after.ids, [t1, list, stop]);

  // Rewinding to a /loop turn drops only local turns: nothing to do in rabi.
  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: stop, restoreFiles: true }, ctx);
  assert.equal(world.calls.at(-1)[0], "revert", "no new engine call");
  assert.equal(world.calls.filter(([m]) => m === "revert").length, 1);
  assert.deepEqual((await readAsTui(h, ctx, thread.id)).ids, [t1, list]);

  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: t1, restoreFiles: true }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 0, true]);
  assert.deepEqual((await readAsTui(h, ctx, thread.id)).ids, []);

  // The conversation carries on with rabi's turn numbers reused after the cut.
  const again = await turn(h, ctx, thread.id, "edit again");
  assert.deepEqual((await readAsTui(h, ctx, thread.id)).ids, [again]);
});

scenario("a scheduled turn and goal rounds are client turns of their own, for rewinding past and to them", async (options) => {
  const { make, ctx, emitted, world } = setup(options);
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await turn(h, ctx, thread.id, "edit one");
  const loop = await turn(h, ctx, thread.id, "/loop 1m check CI");
  world.scheduledTick("[scheduled] check CI");
  await settle();
  const tick = lastStartedTurn(emitted);
  world.goalRounds(3);
  await settle();
  const goal = lastStartedTurn(emitted);
  const t2 = await turn(h, ctx, thread.id, "edit two");

  const read = await readAsTui(h, ctx, thread.id);
  assert.deepEqual(read.ids, [t1, loop, tick, goal, t2]);
  assert.equal(read.last, lastStartedTurn(emitted));
  assert.deepEqual(read.prompts, ["edit one", "/loop 1m check CI", "[scheduled] check CI", "edit two"], "the loop turn shows what was typed");
  const { thread: full } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.equal(full.turns[3].items.filter((i) => i.type === "agentMessage").length, 3, "all three goal rounds are that one turn's");

  // rabi turns: 1 edit one, 2 loop, 3 tick, 4-6 goal rounds, 7 edit two.
  await h["thread/revert/preview"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  assert.deepEqual(world.calls.at(-1), ["preview", 6]);
  await h["thread/revert/preview"]({ threadId: thread.id, beforeTurnId: goal }, ctx);
  assert.deepEqual(world.calls.at(-1), ["preview", 3]);
  await h["thread/revert/preview"]({ threadId: thread.id, beforeTurnId: tick }, ctx);
  assert.deepEqual(world.calls.at(-1), ["preview", 2]);

  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: tick, restoreFiles: true }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 2, true]);
  const after = await readAsTui(h, ctx, thread.id);
  assert.deepEqual(after.ids, [t1, loop]);
  assert.deepEqual(after.prompts, ["edit one", "/loop 1m check CI"]);

  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: loop }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 1, false]);
  assert.deepEqual((await readAsTui(h, ctx, thread.id)).ids, [t1]);
});

scenario("the bookkeeping survives a restart, and a fork keeps the turns it was asked to", async (options) => {
  const { make, ctx, world } = setup(options);
  const first = make();
  const { thread } = await first["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await turn(first, ctx, thread.id, "edit one");
  const list = await turn(first, ctx, thread.id, "/loop");
  const t2 = await turn(first, ctx, thread.id, "edit two");

  const second = make();
  const resumed = await second["thread/resume"]({ threadId: thread.id }, ctx);
  assert.deepEqual(resumed.thread.turns.map((t) => t.id), [t1, list, t2]);

  const forked = await second["thread/fork"]({ threadId: thread.id, lastTurnId: list }, ctx);
  assert.deepEqual(world.calls.at(-1), ["fork", 1], "the fork stops before edit two's rabi turn");
  assert.deepEqual(forked.thread.turns.map((t) => t.id), [t1, list]);

  await second["thread/revert"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 1, false]);
});

scenario("a `!command` turn of its own has no rabi turn", async (options) => {
  const { make, ctx, world } = setup(options);
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await turn(h, ctx, thread.id, "edit one");
  await h["thread/shellCommand"]({ threadId: thread.id, command: "true" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const t2 = await turn(h, ctx, thread.id, "edit two");
  const { thread: read } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.equal(read.turns.length, 3);
  assert.equal(read.turns[0].id, t1);
  assert.equal(read.turns[2].id, t2);
  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 1, false]);
});

scenario("/compact is a turn the client keeps as its latest, so it is in the history too", async (options) => {
  const { make, ctx, emitted, world } = setup(options);
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await turn(h, ctx, thread.id, "edit one");
  await h["thread/compact/start"]({ threadId: thread.id }, ctx);
  await settle();
  const compaction = lastStartedTurn(emitted);
  const read = await readAsTui(h, ctx, thread.id);
  assert.deepEqual(read.ids, [t1, compaction]);
  const { thread: full } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.deepEqual(full.turns[1].items.map((i) => i.type), ["contextCompaction"]);
  const t2 = await turn(h, ctx, thread.id, "edit two");
  await h["thread/revert"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  assert.deepEqual(world.calls.at(-1), ["revert", 1, false]);
  assert.deepEqual((await readAsTui(h, ctx, thread.id)).ids, [t1, compaction]);
});

test("turns from before the bookkeeping map onto the user-prompted rabi turns", () => {
  const history = [
    { anchor: 1, opener: "user", items: [userMessageItem("", "one")], status: "completed" },
    { anchor: 2, opener: null, items: [], status: "completed" },
    { anchor: 3, opener: "user", items: [userMessageItem("", "two")], status: "completed" },
    { anchor: 4, opener: "user", items: [userMessageItem("", "three")], status: "completed" },
  ];
  // a and b predate turnMeta; c was recorded; d has not reached rabi yet.
  const entries = alignTurns({ threadId: "t", turnIds: ["a", "b", "c", "d"], turnMeta: { c: { anchor: 4 } }, history });
  assert.deepEqual(entries.map((e) => [e.id, e.from, e.to]), [["a", 0, 2], ["b", 2, 3], ["c", 3, 4], ["d", 4, 4]]);
  assert.equal(keepTurnsBefore(entries, "b"), 2);
  assert.equal(keepTurnsBefore(entries, "d"), null, "nothing of d's in rabi");

  // A user turn no client turn knows still shows, under an id of its own.
  const lost = alignTurns({ threadId: "t", turnIds: ["a"], turnMeta: { a: { anchor: 1 } }, history });
  assert.deepEqual(lost.map((e) => [e.id, e.from, e.to]), [["a", 0, 2], ["t:turn:a3", 2, 3], ["t:turn:a4", 3, 4]]);
});

test("pages of turns and items are the full history's, cut the way codex cuts them, reading only what they show", async () => {
  const { make, ctx, world } = setup({ ranged: true });
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  await turn(h, ctx, thread.id, "edit one");
  await turn(h, ctx, thread.id, "/loop 1m check CI");
  world.scheduledTick("[scheduled] check CI");
  await settle();
  world.goalRounds(3);
  await settle();
  await turn(h, ctx, thread.id, "/loop");
  await h["thread/compact/start"]({ threadId: thread.id }, ctx);
  await settle();
  await turn(h, ctx, thread.id, "edit two");
  await turn(h, ctx, thread.id, "edit three");

  const { thread: full } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.equal(full.historyMode, "paginated");
  assert.equal(full.turns.length, 8);
  const tool = full.turns[0].items.find((item) => item.type !== "userMessage" && item.type !== "agentMessage");
  assert.equal(tool.status, "completed", "a resumed tool call shows how it ended");

  // The same turns as an engine that reads whole histories gives.
  world.options.ranged = false;
  const whole = make();
  const { thread: legacy } = await whole["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.deepEqual(legacy.turns, full.turns);
  world.options.ranged = true;

  const resumed = await h["thread/resume"]({ threadId: thread.id, excludeTurns: true }, ctx);
  assert.deepEqual(resumed.thread.turns, [], "the client pages it itself");
  assert.equal(resumed.thread.historyMode, "paginated");

  // Turns, newest first, two at a time, with every item.
  const pages = [];
  let cursor = null;
  do {
    const page = await h["thread/turns/list"]({ threadId: thread.id, limit: 2, cursor, itemsView: "full" }, ctx);
    pages.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages.reverse().map(({ itemsView, ...turn }) => turn), full.turns.map(({ itemsView, ...turn }) => turn));

  // Turning back: the backwards cursor starts at the page's first turn again.
  const newest = await h["thread/turns/list"]({ threadId: thread.id, limit: 2 }, ctx);
  assert.deepEqual(newest.data.map((t) => t.id), [full.turns[7].id, full.turns[6].id]);
  const back = await h["thread/turns/list"]({ threadId: thread.id, limit: 5, sortDirection: "asc", cursor: newest.backwardsCursor }, ctx);
  assert.deepEqual(back.data.map((t) => t.id), [full.turns[7].id]);
  assert.equal(back.nextCursor, null);
  const older = await h["thread/turns/list"]({ threadId: thread.id, limit: 3, cursor: newest.nextCursor }, ctx);
  assert.deepEqual(older.data.map((t) => t.id), [5, 4, 3].map((k) => full.turns[k].id));

  // Summaries without reading any turn's items.
  world.reads.length = 0;
  const summaries = await h["thread/turns/list"]({ threadId: thread.id, limit: 100, sortDirection: "asc" }, ctx);
  assert.deepEqual(world.reads, [[0, 0]], "outlines only");
  summaries.data.forEach((turn, k) => {
    assert.equal(turn.itemsView, "summary");
    assert.deepEqual(turn.items, summaryItems(full.turns[k].items), `turn ${k}`);
    assert.equal(turn.status, full.turns[k].status);
  });
  const shells = await h["thread/turns/list"]({ threadId: thread.id, itemsView: "notLoaded" }, ctx);
  assert.ok(shells.data.every((turn) => turn.items.length === 0 && turn.itemsView === "notLoaded"));

  // The last turn with its items reads only that turn's.
  world.reads.length = 0;
  const last = await h["thread/turns/list"]({ threadId: thread.id, limit: 1, itemsView: "full" }, ctx);
  assert.deepEqual(last.data[0].items, full.turns[7].items);
  const rabiTurns = world.sessions.get([...world.sessions.keys()].at(-1));
  const lastRabiTurn = historyFromEvents(rabiTurns, { everyTurn: true }).length;
  assert.deepEqual(world.reads, [[0, 0], [lastRabiTurn - 1, lastRabiTurn]]);

  // Items, newest first, three at a time: every item once, in order.
  const everyItem = full.turns.flatMap((t) => t.items.map((item) => ({ turnId: t.id, item, startedAtMs: null, completedAtMs: null })));
  const items = [];
  cursor = null;
  do {
    const page = await h["thread/items/list"]({ threadId: thread.id, limit: 3, cursor, sortDirection: "desc" }, ctx);
    assert.ok(page.data.length <= 3);
    items.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(items.reverse(), everyItem);

  // One turn's items after an anchor, oldest first.
  const goalTurn = full.turns[3];
  const after = await h["thread/items/list"]({ threadId: thread.id, turnId: goalTurn.id, cursor: { type: "item", itemId: goalTurn.items[0].id } }, ctx);
  assert.deepEqual(after.data.map((entry) => entry.item), goalTurn.items.slice(1));
  await assert.rejects(h["thread/items/list"]({ threadId: thread.id, cursor: { type: "item", itemId: goalTurn.items[0].id } }, ctx), /turnId is required/);
  await assert.rejects(h["thread/turns/list"]({ threadId: thread.id, cursor: JSON.stringify({ turnId: "gone", includeAnchor: false }) }, ctx), /anchor turn is no longer present/);
});
