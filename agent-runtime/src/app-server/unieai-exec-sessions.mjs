// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-exec-sessions.mjs — dsh exec sessions as codex background terminals.
 *
 * codex shows a command the model left running (unified exec) as a
 * `commandExecution` item with a `processId` and the `unifiedExecStartup`
 * source: the TUI lists it under the composer and in `/ps`, and the item's
 * completion takes it off. uac's commands run in unieai-exec; unieai-control
 * reports when one is handed back to the model still running and when it
 * exits (`execSession` notes). This turns those notes into the same items,
 * and answers the background-terminal methods from the live sessions.
 *
 * The items go straight to the client, not through the running turn's item
 * stream: a session outlives the call that started it, and an open card in
 * the turn's stream would hold back every row placed after it until the
 * command exits.
 */

/** The item id a session's started and completed items share. */
export const execItemId = (id) => `exec-session-${id}`;

/** One session (unieai-control's view) as a protocol `commandExecution` item. */
export function execSessionItem(session, { status = "inProgress", exitCode = null, durationMs = null } = {}) {
  const command = String(session.cmd ?? "");
  return {
    type: "commandExecution",
    id: execItemId(session.id),
    command,
    cwd: session.cwd ?? process.cwd(),
    processId: String(session.id),
    source: "unifiedExecStartup",
    status,
    // Unknown, so the client keeps it out of the transcript's explored rows.
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: null,
    exitCode,
    durationMs,
  };
}

/** One session as the protocol's ThreadBackgroundTerminal. */
export function backgroundTerminal(session) {
  return {
    itemId: execItemId(session.id),
    processId: String(session.id),
    command: String(session.cmd ?? ""),
    cwd: session.cwd ?? process.cwd(),
    osPid: null,
    cpuPercent: null,
    rssKb: null,
  };
}

/**
 * @param {object} options
 * @param {(threadId: string) => object | null} options.subagent  a subagent record (unieai-subagent-threads) by thread id
 * @param {(thread: object) => ((method: string, params: object) => void) | null} options.emitterOf
 *   how notifications reach a thread's client; one helper, so a fan-out to
 *   several subscribers replaces it in one place
 */
export function createExecSessions({ subagent, emitterOf }) {
  /** The thread a session's items belong to: the subagent that owns it, else the root. */
  const threadFor = (root, note) => {
    const child = subagent(String(note?.sessionId ?? ""));
    return child && child.root === root ? child : root;
  };

  /** The turn an item in `thread` is filed under: the running one, else the last. */
  const turnIdOf = (thread) => thread.activeTurn?.id ?? thread.lastTurnId ?? thread.turnIds?.at(-1) ?? null;

  /** The engine sessions a thread's list covers: a subagent's own, else the root's. */
  const ownerOf = (thread) => (thread.root ? thread.id : null);
  const engineOf = (thread) => (thread.root ? thread.root.engine : thread.engine);

  const supported = (engine, method) => typeof engine?.[method] === "function";

  return {
    /** unieai-control's `execSession` note, for `root`'s session or one of its subagents. */
    onExecSession(root, note) {
      if (note?.id === undefined || note?.id === null) return;
      const thread = threadFor(root, note);
      const emit = emitterOf(thread.root ?? thread);
      const turnId = turnIdOf(thread);
      if (!emit || !turnId) return;
      const stamp = { threadId: thread.id, turnId };
      if (note.phase === "start") {
        emit("item/started", { ...stamp, item: execSessionItem(note), startedAtMs: Date.now() });
        return;
      }
      if (note.phase === "end") {
        const exitCode = Number.isInteger(note.exitCode) ? note.exitCode : null;
        const startedAt = Number.isFinite(note.startedAt) ? note.startedAt : null;
        const item = execSessionItem(note, {
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
          durationMs: startedAt === null ? null : Math.max(0, Date.now() - startedAt),
        });
        emit("item/completed", { ...stamp, item, completedAtMs: Date.now() });
      }
    },

    /** The running sessions of `thread` (and of its subagents). */
    async list(thread) {
      const engine = engineOf(thread);
      if (!supported(engine, "execSessions")) return [];
      const sessions = await engine.execSessions({ ownerSessionId: ownerOf(thread) });
      return sessions.filter((session) => session.running);
    },

    /** Stop one of `thread`'s sessions. False when it is not one of them, or already ended. */
    async terminate(thread, processId) {
      const engine = engineOf(thread);
      if (!supported(engine, "execKill")) return false;
      const running = await this.list(thread);
      if (!running.some((session) => String(session.id) === String(processId))) return false;
      const { killed } = await engine.execKill(Number(processId));
      return Boolean(killed);
    },

    /** Stop every running session of `thread`. */
    async clean(thread) {
      const engine = engineOf(thread);
      if (!supported(engine, "execKill")) return 0;
      let stopped = 0;
      for (const session of await this.list(thread)) {
        const { killed } = await engine.execKill(session.id).catch(() => ({ killed: false }));
        if (killed) stopped += 1;
      }
      return stopped;
    },

    /** One session's last output, as the client's pager shows it. */
    async output(thread, processId, { maxBytes } = {}) {
      const engine = engineOf(thread);
      if (!supported(engine, "execOutput")) return null;
      const known = (await engine.execSessions({ ownerSessionId: ownerOf(thread) })).some((session) => String(session.id) === String(processId));
      if (!known) return null;
      const result = await engine.execOutput(Number(processId), { maxBytes });
      return {
        processId: String(result.id),
        command: result.cmd,
        cwd: result.cwd ?? null,
        running: Boolean(result.running),
        exitCode: result.exitCode ?? null,
        output: String(result.output ?? ""),
      };
    },
  };
}
