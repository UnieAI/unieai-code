// Persistent threads: list, resume, fork, revert, rename, archive, delete —
// with every response checked against the Rust protocol's generated schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandlers } from "./server.mjs";
import { createThreadStore } from "./thread-store.mjs";
import { validateAgainstSchema, SCHEMA_DIR } from "./schema-check.mjs";
import { userMessageItem, agentMessageItem } from "./items.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skip = existsSync(join(repoRoot, SCHEMA_DIR, "v2", "ThreadListResponse.json")) ? false : "no schemas";

function checkResponse(name, value) {
  const res = validateAgainstSchema(`v2/${name}`, value, { repoRoot });
  assert.equal(res.ok, true, `${name}\n  ${res.problems?.join("\n  ")}`);
}

/**
 * An engine whose "conversation" is a list of user turns, like dsh's session:
 * `send` appends a turn, `revert` truncates, `fork` copies a prefix into a new
 * conversation named by its state.
 */
function fakeEngineWorld() {
  const conversations = new Map(); // state.id -> [{ user, answer }]
  let nextId = 1;
  const factory = ({ resumeState, onState }) => {
    let state = resumeState;
    const turns = () => conversations.get(state?.id) ?? [];
    const ensure = () => {
      if (!state) {
        state = { id: `conv-${nextId++}` };
        conversations.set(state.id, []);
        onState(state);
      }
    };
    return {
      async send(text) {
        ensure();
        turns().push({ user: text, answer: `re: ${text}` });
      },
      async history() {
        return turns().map((turn) => ({
          status: "completed",
          items: [userMessageItem("x", turn.user), agentMessageItem("y", turn.answer)],
        }));
      },
      async fork({ keepTurns }) {
        ensure();
        const kept = turns().slice(0, keepTurns ?? turns().length);
        const child = { id: `conv-${nextId++}` };
        conversations.set(child.id, kept.map((turn) => ({ ...turn })));
        return { state: child, keptTurns: kept.length };
      },
      async revert({ keepTurns }) {
        conversations.set(state.id, turns().slice(0, keepTurns));
      },
      async close() {},
    };
  };
  return { factory, conversations };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "uac-threads-"));
  const path = join(dir, "threads.json");
  const world = fakeEngineWorld();
  const make = () => createHandlers({ createEngineFor: world.factory, codexHome: dir, threadStore: createThreadStore(path) });
  const emitted = [];
  const ctx = { emit: (m, p) => emitted.push([m, p]), request: async () => ({ decision: "decline" }) };
  return { make, ctx, emitted, world };
}

async function runTurn(h, ctx, threadId, text) {
  const { turn } = await h["turn/start"]({ threadId, input: text }, ctx);
  await settle();
  return turn.id;
}

test("threads survive a restart: listed, then resumed with their turn ids", { skip }, async () => {
  const { make, ctx } = setup();
  const first = make();
  const started = await first["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await runTurn(first, ctx, started.thread.id, "one");
  const t2 = await runTurn(first, ctx, started.thread.id, "two");

  const second = make(); // a new process over the same index
  const list = await second["thread/list"]({});
  checkResponse("ThreadListResponse", list);
  assert.deepEqual(list.data.map((t) => [t.id, t.preview, t.status.type]), [[started.thread.id, "one", "notLoaded"]]);
  assert.equal((await second["thread/list"]({ cwd: "/elsewhere" })).data.length, 0);

  const resumed = await second["thread/resume"]({ threadId: started.thread.id }, ctx);
  checkResponse("ThreadResumeResponse", resumed);
  assert.deepEqual(resumed.thread.turns.map((t) => t.id), [t1, t2]);
  assert.deepEqual(
    resumed.thread.turns[1].items.map((i) => i.type),
    ["userMessage", "agentMessage"],
  );

  const read = await second["thread/read"]({ threadId: started.thread.id, includeTurns: true }, ctx);
  checkResponse("ThreadReadResponse", read);
  assert.equal(read.thread.turns.length, 2);

  const turns = await second["thread/turns/list"]({ threadId: started.thread.id, itemsView: "notLoaded" }, ctx);
  checkResponse("ThreadTurnsListResponse", turns);
  assert.deepEqual(turns.data.map((t) => t.id), [t2, t1], "newest first by default");
  const items = await second["thread/items/list"]({ threadId: started.thread.id, turnId: t1, sortDirection: "asc" }, ctx);
  checkResponse("ThreadItemsListResponse", items);
  assert.deepEqual(items.data.map((e) => e.turnId), [t1, t1]);
});

test("revert drops the chosen turn and everything after it, then announces it", { skip }, async () => {
  const { make, ctx, emitted, world } = setup();
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await runTurn(h, ctx, thread.id, "one");
  const t2 = await runTurn(h, ctx, thread.id, "two");
  await runTurn(h, ctx, thread.id, "three");

  const reverted = await h["thread/revert"]({ threadId: thread.id, beforeTurnId: t2 }, ctx);
  checkResponse("ThreadRevertResponse", reverted);
  await settle();
  assert.ok(emitted.some(([m, p]) => m === "thread/reverted" && p.threadId === thread.id));
  const { thread: after } = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.deepEqual(after.turns.map((t) => t.id), [t1]);
  assert.deepEqual([...world.conversations.values()][0].map((t) => t.user), ["one"]);

  await assert.rejects(() => h["thread/revert"]({ threadId: thread.id, beforeTurnId: "gone" }, ctx), /unknown turn/);
});

test("fork copies history through a turn into a new, listed thread", { skip }, async () => {
  const { make, ctx, emitted } = setup();
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const t1 = await runTurn(h, ctx, thread.id, "one");
  await runTurn(h, ctx, thread.id, "two");

  const forked = await h["thread/fork"]({ threadId: thread.id, lastTurnId: t1 }, ctx);
  checkResponse("ThreadForkResponse", forked);
  assert.notEqual(forked.thread.id, thread.id);
  assert.equal(forked.thread.forkedFromId, thread.id);
  assert.deepEqual(forked.thread.turns.map((t) => t.id), [t1], "kept turns keep their ids");
  assert.ok(emitted.some(([m, p]) => m === "thread/started" && p.thread.id === forked.thread.id));

  // The fork is independent: a new turn there leaves the source alone.
  await runTurn(h, ctx, forked.thread.id, "branch");
  const source = await h["thread/read"]({ threadId: thread.id, includeTurns: true }, ctx);
  assert.equal(source.thread.turns.length, 2);
  const branch = await h["thread/read"]({ threadId: forked.thread.id, includeTurns: true }, ctx);
  assert.equal(branch.thread.turns.length, 2);
  assert.equal((await h["thread/list"]({})).data.length, 2);
});

test("rename, archive, unarchive and delete update the index", { skip }, async () => {
  const { make, ctx, emitted } = setup();
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  await runTurn(h, ctx, thread.id, "hello");

  checkResponse("ThreadSetNameResponse", await h["thread/name/set"]({ threadId: thread.id, name: "My task" }, ctx));
  assert.equal((await make()["thread/list"]({ searchTerm: "my task" })).data[0].name, "My task");

  checkResponse("ThreadArchiveResponse", await h["thread/archive"]({ threadId: thread.id }, ctx));
  assert.equal((await h["thread/list"]({})).data.length, 0);
  assert.equal((await h["thread/list"]({ archived: true })).data.length, 1);
  checkResponse("ThreadUnarchiveResponse", await h["thread/unarchive"]({ threadId: thread.id }, ctx));

  checkResponse("ThreadUnsubscribeResponse", await h["thread/unsubscribe"]({ threadId: thread.id }));
  checkResponse("ThreadDeleteResponse", await h["thread/delete"]({ threadId: thread.id }, ctx));
  assert.equal((await make()["thread/list"]({})).data.length, 0);
  assert.deepEqual(
    emitted.map(([m]) => m).filter((m) => /name|archived|deleted/.test(m)),
    ["thread/name/updated", "thread/archived", "thread/unarchived", "thread/deleted"],
  );
});

test("a thread with no turns yet is not listed; goals read as none", { skip }, async () => {
  const { make, ctx } = setup();
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  assert.equal((await h["thread/list"]({})).data.length, 0);
  const goal = await h["thread/goal/get"]({ threadId: thread.id });
  checkResponse("ThreadGoalGetResponse", goal);
  checkResponse("ThreadGoalClearResponse", await h["thread/goal/clear"]({ threadId: thread.id }));
  await runTurn(h, ctx, thread.id, "hello");
  assert.equal((await h["thread/list"]({})).data.length, 1);
});

test("ephemeral threads are never written to the index", { skip }, async () => {
  const { make, ctx } = setup();
  const h = make();
  const { thread } = await h["thread/start"]({ cwd: "/repo", ephemeral: true }, ctx);
  await runTurn(h, ctx, thread.id, "scratch");
  assert.equal((await make()["thread/list"]({})).data.length, 0);
});
