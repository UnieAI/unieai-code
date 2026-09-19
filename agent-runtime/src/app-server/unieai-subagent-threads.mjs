// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-subagent-threads.mjs — dsh subagents as codex agent threads.
 *
 * codex shows a spawned agent in two places: a "Started `/root/name`" row in
 * the parent's transcript (a `subAgentActivity` item), and a thread of its
 * own that the agent picker opens and follows live (`thread/started`, then
 * that thread's turns and items). dsh runs subagents in the parent's process;
 * unieai-control reports when one starts and ends, and pings when its session
 * changes. One record per child turns that into the same notifications; the
 * child's turns are read from dsh's log through the root thread's engine.
 *
 * A child's thread is read-only: its input comes from the agent that
 * started it, not from the user.
 */

const ACTIVITY_KIND = { completed: "completed", aborted: "interrupted", interrupted: "interrupted" };
const epochNow = () => Math.floor(Date.now() / 1000);

/** A label as one agent-path segment: `Count lines in calc.py` -> `count_lines_in_calc_py`. */
export function pathSegment(label, fallback) {
  const slug = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
  return slug || fallback;
}

/**
 * @param {object} options
 * @param {(turn: object, items?: object[]) => object} options.turnShape  the server's Turn shape
 * @param {(fields: object, turns?: object[]) => object} options.threadShape  the server's Thread shape
 * @param {number} [options.refreshMs]  how long activity pings coalesce before a child is re-read
 */
export function createSubagentThreads({ turnShape, threadShape, refreshMs = 300 }) {
  const children = new Map(); // child session id -> record

  const emitOf = (child) => child.root.connection?.emit;

  /** The thread a note's parent session is: another child, else the root thread. */
  const parentOf = (root, parentSessionId) => {
    const parent = children.get(parentSessionId);
    return parent && parent.root === root ? parent : root;
  };

  /** The turn a row in `thread` belongs to: its running turn, else its last. */
  const turnIdOf = (thread) =>
    children.has(thread.id) ? thread.lastTurnId : (thread.activeTurn?.id ?? thread.turnIds?.at(-1) ?? null);

  const uniquePath = (root, base) => {
    const taken = new Set([...children.values()].filter((child) => child.root === root).map((child) => child.path));
    let path = base;
    for (let n = 2; taken.has(path); n += 1) path = `${base}_${n}`;
    return path;
  };

  /** A child's turns in protocol shape, with ids stable across reads. */
  const turnsOf = async (child) => {
    const history = (await child.root.engine?.subagentHistory?.(child.id)) ?? [];
    return history.map((turn, index) => {
      const id = `${child.id}:turn:${index}`;
      const items = turn.items.map((item, k) => ({ ...item, id: `${id}:item:${k}` }));
      return turnShape(
        { id, status: turn.status ?? "completed", startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null },
        items,
      );
    });
  };

  const setRunning = (child, running) => {
    child.running = running;
    child.updatedAtEpoch = epochNow();
    emitOf(child)?.("thread/status/changed", {
      threadId: child.id,
      status: running ? { type: "active", activeFlags: [] } : { type: "idle" },
    });
  };

  /** Notify what changed in a child's turns since its last read. */
  const showTurns = (child, turns) => {
    const emit = emitOf(child);
    if (!emit) return;
    for (const turn of turns) {
      const stamp = { threadId: child.id, turnId: turn.id };
      if (!child.turnsShown.has(turn.id)) {
        child.turnsShown.set(turn.id, "open");
        emit("turn/started", { ...stamp, turn: turnShape({ ...turn, status: "inProgress", completedAt: null }) });
      }
      child.lastTurnId = turn.id;
      for (const item of turn.items) {
        const status = item.status ?? "completed";
        const shown = child.itemsShown.get(item.id);
        if (shown === status) continue;
        if (status !== "inProgress") emit("item/completed", { ...stamp, item, completedAtMs: Date.now() });
        else if (!shown) emit("item/started", { ...stamp, item, startedAtMs: Date.now() });
        child.itemsShown.set(item.id, status);
      }
      if (turn.status !== "inProgress" && child.turnsShown.get(turn.id) !== "done") {
        child.turnsShown.set(turn.id, "done");
        emit("turn/completed", { threadId: child.id, turn: turnShape(turn) });
      }
    }
  };

  /** Re-read a child; pings that arrive meanwhile cause one more read. */
  const refresh = async (child) => {
    if (child.reading) {
      child.readAgain = true;
      return;
    }
    child.reading = true;
    try {
      do {
        child.readAgain = false;
        showTurns(child, await turnsOf(child));
      } while (child.readAgain);
    } catch {
      // The session is not readable right now; the next ping reads again.
    } finally {
      child.reading = false;
    }
  };

  const scheduleRefresh = (child) => {
    if (child.timer) return;
    child.timer = setTimeout(() => {
      child.timer = null;
      refresh(child);
    }, refreshMs);
    child.timer.unref?.();
  };

  /** A `subAgentActivity` row in the parent's transcript. */
  const showActivity = (child, kind) => {
    const parent = child.parent;
    const turnId = turnIdOf(parent);
    if (!turnId) return;
    child.activities += 1;
    const item = { type: "subAgentActivity", id: `${child.id}:activity:${child.activities}`, kind, agentThreadId: child.id, agentPath: child.path };
    // In the root's running turn, through the turn's own emitter: like any
    // card, the row ends the text the model was streaming before it.
    const turnEmit = parent.activeTurn ? parent.pendingAnswer?.emitItem : null;
    if (turnEmit) {
      turnEmit("item/started", { item, startedAtMs: Date.now() });
      turnEmit("item/completed", { item, completedAtMs: Date.now() });
      return;
    }
    emitOf(child)?.("item/completed", { threadId: parent.id, turnId, item, completedAtMs: Date.now() });
  };

  /** A child's fields as the server's threadShape reads them. */
  const threadFields = (child) => ({
    id: child.id,
    cwd: child.cwd,
    model: child.model,
    modelProvider: child.modelProvider,
    permissions: child.permissions,
    createdAtEpoch: child.createdAtEpoch,
    updatedAtEpoch: child.updatedAtEpoch,
    preview: child.nickname ?? "",
    name: child.nickname,
    parentThreadId: child.parent.id,
    agentNickname: child.nickname,
    agentRole: null,
    canAcceptDirectInput: false,
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: child.parent.id,
          depth: child.depth,
          agent_path: child.path,
          agent_nickname: child.nickname,
          agent_role: null,
        },
      },
    },
    statusOverride: child.running ? { type: "active", activeFlags: [] } : { type: "idle" },
  });

  return {
    get: (threadId) => children.get(threadId) ?? null,
    turns: turnsOf,
    threadFields,

    /** unieai-control's `subagent` note, for a child of `root`'s session. */
    onSubagent(root, note) {
      const id = String(note?.sessionId ?? "");
      if (!id) return;
      let child = children.get(id);
      if (note.phase === "start") {
        if (!child) {
          const parent = parentOf(root, note.parentSessionId);
          const base = `${parent.path ?? "/root"}/${pathSegment(note.label, `agent_${id.slice(0, 8)}`)}`;
          child = {
            id,
            root,
            parent,
            path: uniquePath(root, base),
            nickname: note.label ?? null,
            depth: note.depth ?? 1,
            model: note.model ?? root.model ?? null,
            modelProvider: root.modelProvider,
            cwd: note.cwd ?? root.cwd,
            permissions: root.permissions ?? null,
            createdAtEpoch: epochNow(),
            updatedAtEpoch: epochNow(),
            running: false,
            lastTurnId: null,
            turnsShown: new Map(),
            itemsShown: new Map(),
            activities: 0,
            timer: null,
            reading: false,
            readAgain: false,
          };
          children.set(id, child);
          emitOf(child)?.("thread/started", { thread: threadShape(threadFields(child)) });
        }
        setRunning(child, true);
        showActivity(child, "started");
        scheduleRefresh(child);
        return;
      }
      if (note.phase === "end" && child) {
        // The last read first, so the child's final answer is in its thread
        // before the parent's "Completed" row.
        refresh(child).then(() => {
          setRunning(child, false);
          showActivity(child, ACTIVITY_KIND[note.stopReason] ?? "completed");
        });
      }
    },

    /** unieai-control's `childActivity` ping. */
    onChildActivity(root, note) {
      const child = children.get(String(note?.sessionId ?? ""));
      if (child?.root === root) scheduleRefresh(child);
    },

  };
}
