/**
 * shell-session.mjs — one shell that stays alive across tool calls.
 *
 * `bash` spawns a fresh process per command, so everything the command changed
 * about its own environment is gone by the next one: `cd` into the package,
 * activate the venv, export a flag — the next call starts back at the workspace
 * root with none of it. The model has to re-establish its context in every
 * command it writes, and when it forgets, the command runs somewhere it did not
 * intend. codex solved this with `exec_command`/`write_stdin` over a persistent
 * shell; this is the same idea.
 *
 * How a command's end is detected: after the command, the session writes a
 * sentinel line carrying `$?`. The sentinel is a per-session random token, so
 * output that happens to contain the word cannot end a command early.
 *
 * What happens on timeout: the command is still running and its output is still
 * coming, so the stream can no longer be trusted to line up with the next
 * command. The session is killed and replaced, and the caller is told the
 * environment was reset — losing `cd` is recoverable, silently attributing one
 * command's output to another is not.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killTree } from "./process-manager.mjs";
import { IS_WIN } from "./portable-exec.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

// Sessions are unref'd so an idle shell cannot hold the program open; this is
// the other half of that bargain — whatever is still alive when the program
// ends gets killed with it, rather than surviving as an orphan.
const live = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const proc of live) killTree(proc, "SIGKILL");
  });
}

/** Shell-single-quote a string, for embedding in the sentinel command. */
function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {object} p
 * @param {string[]} p.argv    how to launch the shell (see portable-exec)
 * @param {string} p.cwd       where it starts
 * @param {object} [p.env]
 */
export function createShellSession({ argv, cwd, env = process.env } = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new Error("createShellSession requires an argv");

  let child = null;
  let buffer = "";
  let waiter = null; // { sentinel, resolve, timer }
  let generation = 0;
  let spawnError = null;

  function start() {
    generation += 1;
    buffer = "";
    const [file, ...args] = argv;
    // `detached` makes the shell a process-group leader, which is what lets a
    // timed-out command be killed along with whatever it started. Without it,
    // killing the shell leaves an orphan holding our stdio pipes open: the
    // command keeps running, its output keeps arriving on a stream nobody is
    // reading, and the process never exits.
    const proc = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !IS_WIN });
    child = proc;
    // Every handler checks that it still belongs to the CURRENT shell. A killed
    // shell's exit fires after its replacement has been spawned, and an
    // unguarded handler would clear the new shell out from under itself — the
    // session would look alive and accept commands nothing was listening to.
    const mine = () => child === proc;
    proc.on("error", (err) => { if (mine()) { spawnError = err; settleAll(); } });
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => { if (mine()) onData(c); });
    // stderr is merged per command (`2>&1`), so anything arriving here is the
    // shell's own complaint — worth showing rather than dropping.
    proc.stderr.on("data", (c) => { if (mine()) onData(c); });
    proc.on("exit", () => { if (mine()) { child = null; settleAll(); } });
    // An idle shell must not hold the process open. While a command is running
    // there is always a pending timeout keeping the loop alive, so unref'ing
    // costs nothing there — but between calls, and after the host is done, the
    // program should be free to exit. The exit hook is what stops that leaving
    // an orphan behind.
    proc.unref();
    proc.stdout.unref?.();
    proc.stderr.unref?.();
    proc.stdin.unref?.();
    live.add(proc);
    proc.on("exit", () => live.delete(proc));
    installExitHook();
  }

  function settleAll() {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    w.resolve({ output: buffer, exitCode: null, timedOut: false, died: true });
    buffer = "";
  }

  function onData(chunk) {
    buffer += chunk;
    if (!waiter) return;
    const at = buffer.indexOf(waiter.sentinel);
    if (at < 0) return;
    // Everything before the sentinel is the command's output; the rest of the
    // sentinel line carries its exit status.
    const before = buffer.slice(0, at);
    const rest = buffer.slice(at + waiter.sentinel.length);
    const nl = rest.indexOf("\n");
    if (nl < 0) return; // the status has not fully arrived yet
    const code = Number.parseInt(rest.slice(0, nl).trim(), 10);
    buffer = rest.slice(nl + 1);
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    w.resolve({ output: before, exitCode: Number.isFinite(code) ? code : null, timedOut: false, died: false });
  }

  /**
   * Run one command and wait for it to finish.
   *
   * @returns {Promise<{output:string, exitCode:number|null, timedOut:boolean, restarted:boolean, spawnError?:string}>}
   */
  async function run(cmd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (waiter) throw new Error("this shell session is already running a command");
    if (!child) start();
    if (spawnError) return { output: "", exitCode: null, timedOut: false, restarted: false, spawnError: String(spawnError.message || spawnError) };

    const sentinel = `__unieai_done_${randomUUID().replace(/-/g, "")}__`;
    const startedGeneration = generation;
    const done = new Promise((resolve) => {
      waiter = { sentinel, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        if (!waiter) return;
        const w = waiter;
        waiter = null;
        w.resolve({ output: buffer, exitCode: null, timedOut: true, died: false });
        buffer = "";
      }, Math.max(1, timeoutMs));
    });

    // `{ ...; } 2>&1` merges the command's stderr into the same stream the
    // sentinel travels on, so ordering between them is the shell's, not ours.
    child.stdin.write(`{ ${cmd}\n} 2>&1\n__unieai_rc=$?\nprintf '\\n%s %s\\n' ${sq(sentinel)} "$__unieai_rc"\n`);

    const result = await done;
    if (result.timedOut || result.died) {
      // The stream and the commands have come apart. A fresh shell is the only
      // state we can describe honestly.
      kill();
      start();
      return {
        output: result.output,
        exitCode: null,
        timedOut: result.timedOut,
        restarted: true,
        died: Boolean(result.died) && generation !== startedGeneration,
      };
    }
    return { ...result, restarted: false };
  }

  /**
   * Feed raw text to the shell's stdin, for a command left waiting for input.
   * Returns whatever arrives within `waitMs` — there is no sentinel to wait for,
   * because the thing being fed is not a command we issued.
   */
  async function writeStdin(text, { waitMs = 500 } = {}) {
    if (!child) start();
    buffer = "";
    child.stdin.write(String(text ?? ""));
    await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
    const out = buffer;
    buffer = "";
    return { output: out };
  }

  function kill() {
    if (!child) return;
    const proc = child;
    child = null;
    live.delete(proc);
    killTree(proc, "SIGKILL");
    // The group signal covers the processes; these release the handles this
    // process still holds, so a lingering grandchild cannot keep us alive.
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
      try { stream?.destroy(); } catch { /* already closed */ }
    }
  }

  return {
    run,
    writeStdin,
    close: kill,
    get alive() { return Boolean(child); },
    get busy() { return Boolean(waiter); },
  };
}
