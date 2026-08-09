/**
 * process-manager.mjs — long-running child processes the agent can start, poll and stop.
 *
 * The `bash` tool is a one-shot: it blocks the turn and gives up after 60s, so a
 * dev server, a watch build or a full test suite is simply not runnable. Those
 * jobs share a shape the blocking executor cannot express — they outlive the
 * tool call, they are interesting WHILE they run, and they have to be killable.
 * This module owns exactly that lifecycle and nothing else; the tool schemas
 * that expose it are wired separately, and the caller decides whether to hand
 * the returned text to `spillIfLarge` before it reaches the model.
 *
 * Commands are launched through the SAME shape as `bash`
 * (`<sandboxBin> sandbox -- <shellArgv(cmd)>`, via `prepareExec`) so a command
 * does not gain reach just by being backgrounded. `sandbox: false` mirrors
 * `bash`'s post-approval path and is the caller's decision, made after the host
 * approval channel said yes — this module never escalates on its own, because
 * there is no turn left to ask in by the time a background job is denied.
 */

import { spawn } from "node:child_process";
import { IS_WIN, prepareExec, shellArgv, sandboxArgv } from "./portable-exec.mjs";

/**
 * Defaults, all overridable per manager.
 *
 * MAX_LINES/MAX_BYTES are the retention window, not a quota: output over them is
 * dropped from the FRONT while the process keeps running (see OutputRing).
 * RETENTION_MS keeps an exited process readable long enough for the next poll to
 * find out why it died — a job that dies in the first second is the single most
 * important case, and reaping it immediately would make it invisible.
 */
export const DEFAULTS = Object.freeze({
  maxLines: 2000,
  maxBytes: 256 * 1024,
  maxLineChars: 8192,
  killGraceMs: 3000,
  retentionMs: 5 * 60 * 1000,
  maxRetained: 32,
  maxRunning: 8,
  readTail: 200,
});

/**
 * Every manager alive in this process. Two consumers, one set.
 *
 * The exit hook below needs it so a single hook covers every manager. An
 * in-process UI needs it for a different reason: the manager is created inside
 * a toolset closure and neither the toolset nor the engine hands it back, so a
 * host that wants to SHOW what it started (the TUI's /ps, the extension's
 * status bar) has no other honest route to it. Registration happens at
 * construction rather than at first spawn, so a command that failed to spawn is
 * visible too — that is precisely the case a monitor exists to surface.
 */
const LIVE_MANAGERS = new Set();
let exitHookInstalled = false;

/**
 * Backstop against orphaning a dev server when the host goes away.
 *
 * Children are spawned into their own process group and are NOT ref-detached, so
 * an orderly shutdown runs through dispose(). This hook only covers the paths
 * that skip it (process.exit, an uncaught throw): it must be synchronous, so it
 * goes straight to SIGKILL rather than the polite-then-forceful escalation.
 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const manager of LIVE_MANAGERS) manager._killAllNow();
  });
}

/**
 * Bounded store of recent output lines.
 *
 * WHY a ring and not a file or an unbounded array: a watch build re-printing on
 * every save emits megabytes over an hour, and an agent polling it wants "what
 * happened since I last looked", never the whole hour. An unbounded array turns
 * a healthy long-running job into an OOM; spilling to disk would keep everything
 * but buys nothing the agent can use — it still only ever reads the tail, and it
 * would put an unbounded write stream and a temp-file lifecycle on a path that
 * has to survive being forgotten about.
 *
 * The trade-off, stated plainly: OLD OUTPUT IS LOST. A build that printed its
 * only error message 5000 lines ago has lost it, and the agent will see a
 * dropped-line count instead. That is the right way round — a compile error is
 * near the end of the interesting window, whereas startup banners are not — but
 * it means this buffer is a monitor, not an archive. A caller that needs the
 * full transcript should redirect the command's own output to a file
 * (`npm run build > build.log 2>&1`) and read that file.
 *
 * Two caps, because either alone has a hole: a line cap alone lets one program
 * printing a 10MB single-line JSON blow the budget, and a byte cap alone lets a
 * flood of empty lines cost far more in per-entry overhead than in bytes.
 */
class OutputRing {
  constructor({ maxLines, maxBytes, maxLineChars }) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.maxLineChars = maxLineChars;
    /** @type {{ seq: number, text: string, bytes: number }[]} */
    this.lines = [];
    /** Sequence of the next line to be appended; also the cursor a reader gets back. */
    this.nextSeq = 0;
    /** Lines evicted so far — the honest "you missed this much" counter. */
    this.dropped = 0;
    this.bufferedBytes = 0;
    this.totalBytes = 0;
    /** Per-stream carry for a chunk that ended mid-line. */
    this.pending = { stdout: "", stderr: "" };
  }

  /** Sequence of the oldest line still held. */
  get firstSeq() {
    return this.lines.length > 0 ? this.lines[0].seq : this.nextSeq;
  }

  push(text) {
    const bytes = Buffer.byteLength(text, "utf8");
    this.lines.push({ seq: this.nextSeq, text, bytes });
    this.nextSeq += 1;
    this.bufferedBytes += bytes;
    this.totalBytes += bytes;
    while (this.lines.length > this.maxLines || (this.bufferedBytes > this.maxBytes && this.lines.length > 1)) {
      const gone = this.lines.shift();
      this.bufferedBytes -= gone.bytes;
      this.dropped += 1;
    }
  }

  /**
   * Split an incoming chunk into lines.
   *
   * `\r` counts as a terminator, not text: progress bars redraw with a bare CR,
   * and treating it as ordinary content would grow one unbounded "line" that the
   * line cap cannot see. The trailing fragment is carried, so a half-received
   * line is never handed to a reader as if it were complete — unless it grows
   * past maxLineChars, at which point holding it costs more than the fidelity is
   * worth and it is flushed as-is.
   */
  write(stream, chunk) {
    const buffered = this.pending[stream] + chunk;
    const parts = buffered.split(/\r\n|\n|\r/);
    this.pending[stream] = parts.pop() ?? "";
    for (const part of parts) this.push(part);
    if (this.pending[stream].length > this.maxLineChars) {
      this.push(this.pending[stream]);
      this.pending[stream] = "";
    }
  }

  /** Commit any half-line still carried; called when a stream ends. */
  flush(stream) {
    if (this.pending[stream]) {
      this.push(this.pending[stream]);
      this.pending[stream] = "";
    }
  }

  /**
   * Read lines at or after `cursor`, or the last `tail` lines when there is none.
   *
   * The cursor exists because polling is the common case and re-sending the same
   * 200 lines on every poll is how a monitoring loop eats a context window.
   */
  read({ cursor, tail }) {
    let selected;
    let missed = 0;
    if (typeof cursor === "number" && Number.isFinite(cursor)) {
      const from = Math.max(0, Math.trunc(cursor));
      missed = Math.max(0, this.firstSeq - from);
      selected = this.lines.filter((l) => l.seq >= from);
    } else {
      const want = Math.max(0, tail ?? DEFAULTS.readTail);
      selected = want >= this.lines.length ? this.lines.slice() : this.lines.slice(this.lines.length - want);
      missed = this.dropped + (this.lines.length - selected.length);
    }
    return {
      lines: selected.map((l) => l.text),
      cursor: this.nextSeq,
      droppedLines: missed,
    };
  }
}

/**
 * Kill a whole process tree.
 *
 * A naive `child.kill()` signals the `sh -c` wrapper only. The shell exits, the
 * `vite`/`tsc --watch` it started keeps the port and the CPU, and nothing owns it
 * any more. On POSIX the fix is at spawn time: `detached: true` runs setsid(), so
 * the child is a process-group LEADER whose pgid equals its pid, and a negative
 * pid signals the entire group — wrapper, sandbox helper and real work together.
 * Windows has no process groups worth signalling, so `taskkill /T` walks the
 * parent/child table instead; it has no graceful mode a console app would honour,
 * hence /F on both passes.
 */
export function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  if (IS_WIN) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
      return true;
    } catch {
      try { return child.kill("SIGKILL"); } catch { return false; }
    }
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (e) {
    // ESRCH: the group is already gone. Anything else (a child that never made
    // it into its own group) still deserves the direct signal as a fallback.
    if (e?.code === "ESRCH") return false;
    try { return child.kill(signal); } catch { return false; }
  }
}

/**
 * Create a manager. One per session: the id counter, the process table and the
 * caps are per-instance, so two concurrent sessions can never see or stop each
 * other's jobs.
 */
export function createProcessManager({
  workspace = process.cwd(),
  sandboxBin = process.env.UNIEAI_BIN || "unieai",
  maxLines = DEFAULTS.maxLines,
  maxBytes = DEFAULTS.maxBytes,
  maxLineChars = DEFAULTS.maxLineChars,
  killGraceMs = DEFAULTS.killGraceMs,
  retentionMs = DEFAULTS.retentionMs,
  maxRetained = DEFAULTS.maxRetained,
  maxRunning = DEFAULTS.maxRunning,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, any>} */
  const table = new Map();
  let counter = 0;
  let disposed = false;

  /** Short and typeable: the model has to echo this id back in the next call. */
  function nextId() {
    counter += 1;
    return `bg_${counter}`;
  }

  function isRunning(rec) {
    return rec.status === "running";
  }

  /**
   * Reap exited processes.
   *
   * Swept lazily on every entry point rather than on a timer: a timer either
   * holds the event loop open (the exact bug this module has to avoid) or needs
   * unref plus its own teardown, and a table this small costs nothing to walk.
   */
  function sweep({ force = false } = {}) {
    const t = now();
    const removed = [];
    for (const [id, rec] of table) {
      if (isRunning(rec)) continue;
      if (force || t - rec.exitedAt >= retentionMs) {
        table.delete(id);
        removed.push(id);
      }
    }
    // Even inside the retention window the table must not grow without bound,
    // so an over-cap backlog gives up its oldest corpses early.
    const exited = [...table.values()].filter((r) => !isRunning(r)).sort((a, b) => a.exitedAt - b.exitedAt);
    for (let i = 0; i < exited.length - maxRetained; i += 1) {
      table.delete(exited[i].id);
      removed.push(exited[i].id);
    }
    return removed;
  }

  function settle(rec, patch) {
    if (!isRunning(rec)) return;
    Object.assign(rec, patch, { exitedAt: now() });
    for (const resolve of rec.waiters) resolve(snapshot(rec));
    rec.waiters.length = 0;
  }

  function snapshot(rec) {
    return {
      id: rec.id,
      command: rec.command,
      pid: rec.pid,
      status: rec.status,
      exitCode: rec.exitCode,
      signal: rec.signal,
      sandbox: rec.sandbox,
      cwd: rec.cwd,
      startedAt: rec.startedAt,
      exitedAt: rec.exitedAt,
      uptimeMs: (rec.exitedAt ?? now()) - rec.startedAt,
      outputBytes: rec.ring.totalBytes,
      bufferedBytes: rec.ring.bufferedBytes,
      outputLines: rec.ring.nextSeq,
      droppedLines: rec.ring.dropped,
      cursor: rec.ring.nextSeq,
      error: rec.error,
    };
  }

  const manager = {
    /**
     * Launch `command` in the background and return its handle immediately.
     *
     * Resolves as soon as the spawn is under way, NOT when the command finishes
     * — that is the entire point. A binary that cannot be launched at all still
     * lands in the table (status "failed") rather than throwing, so the agent
     * can read the reason through the same call it would use for any other
     * failure instead of needing a second error path.
     */
    start({ command, cwd, sandbox = true, label = "" } = {}) {
      if (disposed) return { ok: false, error: "process manager has been disposed" };
      sweep();
      const cmd = String(command || "").trim();
      if (!cmd) return { ok: false, error: "command is required" };
      const running = [...table.values()].filter(isRunning);
      if (running.length >= maxRunning) {
        return {
          ok: false,
          error: `too many background processes (${running.length}/${maxRunning}); stop one first: ${running.map((r) => r.id).join(", ")}`,
        };
      }

      const argv = sandbox ? sandboxArgv(sandboxBin, cmd) : shellArgv(cmd);
      const spec = prepareExec(argv[0], argv.slice(1));
      const workdir = cwd ? String(cwd) : workspace;
      const id = nextId();
      const rec = {
        id,
        command: cmd,
        label: String(label || ""),
        cwd: workdir,
        sandbox,
        status: "running",
        exitCode: null,
        signal: null,
        error: null,
        pid: null,
        startedAt: now(),
        exitedAt: null,
        ring: new OutputRing({ maxLines, maxBytes, maxLineChars }),
        child: null,
        waiters: [],
      };
      table.set(id, rec);

      let child;
      try {
        child = spawn(spec.file, spec.args, {
          cwd: workdir,
          shell: spec.shell,
          windowsHide: true,
          // See killTree: detached is what makes the child a group leader, and
          // therefore what makes stop() reach the work instead of the wrapper.
          detached: !IS_WIN,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        settle(rec, { status: "failed", exitCode: null, error: String(e?.message || e) });
        return { ok: false, id, error: rec.error, process: snapshot(rec) };
      }

      rec.child = child;
      rec.pid = child.pid ?? null;
      installExitHook();

      // stdout and stderr are merged in ARRIVAL order rather than kept apart:
      // a server's request log and the stack trace that interrupts it only make
      // sense interleaved, and every consumer of this buffer is reading it as a
      // terminal transcript, not parsing one stream.
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => rec.ring.write("stdout", chunk));
      child.stderr?.on("data", (chunk) => rec.ring.write("stderr", chunk));
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});

      child.on("error", (e) => {
        // A spawn failure reports a string errno and never ran; keep it distinct
        // from a command that ran and exited non-zero, the same way `run()` in
        // tools.mjs does, so the caller can explain the environment problem.
        rec.ring.write("stderr", `${e?.code ? `${e.code}: ` : ""}${e?.message || e}\n`);
        settle(rec, { status: "failed", exitCode: null, error: String(e?.message || e) });
      });

      // "exit" fires when the direct child is gone, "close" only once every
      // inherited stdio handle is released — which a detached grandchild can
      // hold open indefinitely. Status therefore comes from "exit"; "close" is
      // used solely to commit whatever half-line was still in flight.
      child.on("exit", (code, signal) => {
        settle(rec, {
          status: signal ? "killed" : "exited",
          exitCode: typeof code === "number" ? code : null,
          signal: signal ?? null,
        });
      });
      child.on("close", () => {
        rec.ring.flush("stdout");
        rec.ring.flush("stderr");
      });

      return { ok: true, id, pid: rec.pid, process: snapshot(rec) };
    },

    /** Every process this manager knows about, newest last. */
    list({ includeExited = true, status } = {}) {
      sweep();
      return [...table.values()]
        .filter((rec) => (includeExited || isRunning(rec)) && (!status || rec.status === status))
        .map(snapshot);
    },

    /** One process's metadata, or null once it has been reaped. */
    status(id) {
      sweep();
      const rec = table.get(String(id));
      return rec ? snapshot(rec) : null;
    },

    /**
     * Read recent output.
     *
     * Pass the `cursor` from the previous read to get ONLY what arrived since —
     * the polling case — or omit it for the last `tail` lines. Output stays
     * readable after exit for the whole retention window, because "why did it
     * die" is a question that can only be asked once it is dead.
     */
    read(id, { cursor, tail = DEFAULTS.readTail } = {}) {
      sweep();
      const rec = table.get(String(id));
      if (!rec) {
        return { ok: false, error: `unknown process ${id} (it may have exited and been cleaned up)` };
      }
      const page = rec.ring.read({ cursor, tail });
      return {
        ok: true,
        ...snapshot(rec),
        ...page,
        text: page.lines.join("\n"),
        running: isRunning(rec),
      };
    },

    /**
     * Terminate a process tree: polite first, forceful after the grace period.
     *
     * SIGTERM gives a dev server the chance to release its port and a test runner
     * the chance to write its report; SIGKILL after `graceMs` is what guarantees
     * the call actually means something. `forced` in the result tells the caller
     * which one it took, because a job that ignores SIGTERM is worth knowing about.
     */
    async stop(id, { graceMs = killGraceMs, signal = "SIGTERM" } = {}) {
      const rec = table.get(String(id));
      if (!rec) return { ok: false, error: `unknown process ${id}` };
      if (!isRunning(rec)) return { ok: true, id: rec.id, alreadyExited: true, forced: false, process: snapshot(rec) };

      const exited = manager.waitForExit(rec.id, { timeoutMs: graceMs });
      killTree(rec.child, signal);
      let result = await exited;
      let forced = false;
      if (!result) {
        forced = true;
        const dead = manager.waitForExit(rec.id, { timeoutMs: Math.max(1000, graceMs) });
        killTree(rec.child, "SIGKILL");
        result = await dead;
        // The handle can survive SIGKILL only if the pid is unreachable (a
        // permission change, a pid namespace); record it rather than hang.
        if (!result) settle(rec, { status: "killed", exitCode: null, signal: "SIGKILL", error: "process did not exit after SIGKILL" });
      }
      return { ok: true, id: rec.id, forced, process: snapshot(rec) };
    },

    /** Stop everything still running, in parallel; used at session teardown. */
    async stopAll(options = {}) {
      const running = [...table.values()].filter(isRunning);
      const results = await Promise.all(running.map((rec) => manager.stop(rec.id, options)));
      return results;
    },

    /**
     * Resolve when the process exits, or with null if `timeoutMs` elapses first.
     *
     * Null-on-timeout rather than a rejection: "still running" is an ordinary
     * answer to "is the build done yet", not an error anyone should have to catch.
     */
    waitForExit(id, { timeoutMs } = {}) {
      const rec = table.get(String(id));
      if (!rec) return Promise.resolve(null);
      if (!isRunning(rec)) return Promise.resolve(snapshot(rec));
      return new Promise((resolve) => {
        let settled = false;
        const once = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = typeof timeoutMs === "number" ? setTimeout(() => once(null), timeoutMs) : null;
        // The timer must not be what keeps a CLI alive after the work is done.
        timer?.unref?.();
        rec.waiters.push(once);
      });
    },

    /**
     * Drop exited entries. `force` ignores the retention window entirely, which
     * is what a session reset wants; the default only reaps what has aged out.
     * Running processes are never removed — losing the handle to a live dev
     * server would leak it beyond any hope of stopping it.
     */
    cleanup({ force = false } = {}) {
      return sweep({ force });
    },

    /** Stop everything and release the process-exit hook. Idempotent. */
    async dispose(options = {}) {
      disposed = true;
      const results = await manager.stopAll(options);
      sweep({ force: true });
      LIVE_MANAGERS.delete(manager);
      return results;
    },

    /** Synchronous last resort for the process-exit hook. Not part of the API. */
    _killAllNow() {
      for (const rec of table.values()) {
        if (isRunning(rec)) killTree(rec.child, "SIGKILL");
      }
    },
  };

  LIVE_MANAGERS.add(manager);
  return manager;
}

/**
 * Every manager still live in this process, oldest first.
 *
 * Returns the MANAGERS rather than a flattened process list on purpose: ids are
 * only unique within one manager (`bg_1` exists in every one of them), so a
 * caller that wants to stop something needs the owner, not just the id. A
 * caller that only wants to display can flatMap `list()` over the result.
 *
 * Entries are dropped by dispose(); a host that abandons a manager without
 * disposing it keeps that manager — and any process still running under it —
 * visible here, which is the useful behaviour: a dev server started before
 * "new chat" is still holding its port and the user still needs a way to see it.
 */
export function liveProcessManagers() {
  return [...LIVE_MANAGERS];
}
