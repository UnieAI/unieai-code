// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-exec.mjs — codex-style non-blocking command execution for dsh.
 *
 * dsh's `bash` tool blocks the turn until the command ends or its 60s timeout
 * kills it, has no stdin and no PTY. Builds, full test suites, dev servers and
 * interactive programs all fall through that gap. This plugin replaces it with
 * the two tools the codex models are trained on:
 *
 *   exec_command {cmd, workdir?, tty?, yield_time_ms?, max_output_tokens?, login?}
 *   write_stdin  {session_id, chars?, yield_time_ms?, max_output_tokens?}
 *
 * A command runs until it exits or `yield_time_ms` passes; a command still
 * running then is kept as a session the model polls (empty `chars`) or types
 * into (`tty: true`). Sessions are not tied to the tool call that started
 * them, so an interrupted turn does not kill a server; they end when their
 * agent or this plugin is disposed.
 *
 * Only public dsh seams are used: `ctx.subprocess` (pipes and PTYs),
 * `ctx.sandbox.confine` + `ctx.sandboxPolicy` (the same confinement bash
 * gets), `approveEscalation` (the same approval flow), `ctx.shellEnv` (the
 * managed DSH_* facts). Load it with a patch `insert` by file URL and disable
 * the `tool-bash` row (see config.mjs).
 */
import { spawn as spawnDetached } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  ESCALATION_TARGETS,
  approveEscalation,
  classifyRunnerFailure,
  escalationHintMarker,
  matchesSignature,
  sandboxDenialMarker,
  validateEscalationArgs,
} from "@deepseek-ai/dsh-sandbox";
import { TOOL_ABORTED, defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";

export const name = "unieai-exec";
export const inject = ["tools", "subprocess", "sandboxPolicy", "shellEnv", "systemPrompt"];

/** Codex's constants (unified_exec/mod.rs), plus the dsh-side knobs. */
export const DEFAULTS = Object.freeze({
  // 10s made the model poll a finished-in-12s build three or four times; a
  // longer first wait costs nothing when the command exits earlier.
  defaultYieldMs: 30_000, // exec_command
  defaultWriteYieldMs: 250, // write_stdin with input
  minYieldMs: 250,
  maxYieldMs: 30_000,
  minPollMs: 5_000, // write_stdin with empty chars
  maxPollMs: 300_000, // codex background_terminal_max_timeout
  maxOutputTokens: 10_000,
  // Kept under spill-policy's 50000-byte inline cap so a result is never
  // truncated twice.
  maxOutputTokensCap: 11_000,
  // How long a detached command is watched for an immediate crash.
  detachProbeMs: 1_500,
  bufferBytes: 1 << 20, // per-call head/tail window
  spillBytes: 64 << 20,
  maxSessions: 16, // per agent
  protectRecent: 4, // most recently used sessions never pruned
  graceMs: 3_000,
  pollIntervalMs: 100,
  postExitWaitMs: 50,
  ttyWriteSettleMs: 100,
  allowTty: true,
  login: false,
  rows: 40,
  cols: 160,
  terminalType: "dumb",
});

export const INTERRUPT = "\u0003";
export const STDIN_CLOSED_MESSAGE =
  "stdin is closed for this session; rerun exec_command with tty=true to keep stdin open";
const BYTES_PER_TOKEN = 4;
/** What the model sees for a signal death; shells report 128+N the same way. */
const signalExitCode = (signal) => 128 + (osConstants.signals[signal] ?? 0);

const byteLength = (text) => Buffer.byteLength(text, "utf8");
export const approxTokens = (bytes) => Math.ceil(bytes / BYTES_PER_TOKEN);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longest prefix of `text` that fits `maxBytes`, never splitting a character. */
export function prefixByBytes(text, maxBytes) {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const size = byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += ch.length;
  }
  return text.slice(0, index);
}

/** Shortest suffix of `text` whose bytes fit `maxBytes`, never splitting a character. */
export function suffixByBytes(text, maxBytes) {
  let bytes = 0;
  let index = text.length;
  const chars = Array.from(text);
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const size = byteLength(chars[i]);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index -= chars[i].length;
  }
  return text.slice(index);
}

/**
 * Keeps the first and last halves of a stream and counts what fell between.
 * The start of a build log holds the first error, the end holds the verdict;
 * the middle is what can go (codex head_tail_buffer.rs).
 */
export class HeadTailBuffer {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.headMax = Math.floor(maxBytes / 2);
    this.tailMax = maxBytes - this.headMax;
    this.head = "";
    this.headBytes = 0;
    this.tail = [];
    this.tailBytes = 0;
    this.omittedBytes = 0;
    this.totalBytes = 0;
  }

  push(text, { omitted = 0 } = {}) {
    if (omitted > 0) {
      // Bytes the source already dropped: they sit between what we have and `text`.
      this.omittedBytes += omitted;
      this.totalBytes += omitted;
      this.headMax = this.headBytes; // the head is closed once there is a gap
    }
    if (!text) return;
    const bytes = byteLength(text);
    this.totalBytes += bytes;
    let rest = text;
    if (this.headBytes < this.headMax) {
      const room = this.headMax - this.headBytes;
      const part = bytes <= room ? text : prefixByBytes(text, room);
      this.head += part;
      this.headBytes += byteLength(part);
      rest = text.slice(part.length);
      if (!rest) return;
    }
    this.tail.push(rest);
    this.tailBytes += byteLength(rest);
    while (this.tailBytes > this.tailMax) {
      const first = this.tail[0];
      const firstBytes = byteLength(first);
      const excess = this.tailBytes - this.tailMax;
      if (firstBytes <= excess) {
        this.tail.shift();
        this.tailBytes -= firstBytes;
        this.omittedBytes += firstBytes;
      } else {
        const kept = suffixByBytes(first, firstBytes - excess);
        const dropped = firstBytes - byteLength(kept);
        this.tail[0] = kept;
        this.tailBytes -= dropped;
        this.omittedBytes += dropped;
      }
    }
  }

  /** Moves everything into `other`, leaving this buffer empty. */
  drainInto(other) {
    if (this.totalBytes === 0) return;
    other.push(this.head);
    const tail = this.tail.join("");
    other.push(tail, { omitted: this.omittedBytes });
    Object.assign(this, new HeadTailBuffer(this.maxBytes));
  }

  get empty() {
    return this.totalBytes === 0;
  }

  text() {
    const tail = this.tail.join("");
    if (this.omittedBytes === 0) return this.head + tail;
    const sep = this.head && !this.head.endsWith("\n") ? "\n" : "";
    return `${this.head}${sep}... ${this.omittedBytes} bytes omitted ...\n${tail}`;
  }
}

/** Codex truncate_middle_with_token_budget: head + `…N tokens truncated…` + tail. */
export function truncateMiddle(text, maxTokens) {
  const budget = maxTokens * BYTES_PER_TOKEN;
  const total = byteLength(text);
  if (total <= budget) return text;
  const left = Math.floor(budget / 2);
  const head = prefixByBytes(text, left);
  const tail = suffixByBytes(text.slice(head.length), budget - left);
  return `${head}…${approxTokens(total - budget)} tokens truncated…${tail}`;
}

/** Codex formatted_truncate_text, with the original size counting dropped bytes too. */
export function formatOutput(text, maxTokens, totalBytes = byteLength(text)) {
  if (byteLength(text) <= maxTokens * BYTES_PER_TOKEN) return text;
  const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  return (
    `Warning: truncated output (original token count: ${approxTokens(totalBytes)})\n` +
    `Total output lines: ${lines}\n\n${truncateMiddle(text, maxTokens)}`
  );
}

/** The codex response header (tools/context.rs), then the output. */
export function renderResponse(value) {
  const lines = [];
  if (value.chunk_id) lines.push(`Chunk ID: ${value.chunk_id}`);
  lines.push(`Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`);
  if (value.exit_code !== undefined && value.exit_code !== null) lines.push(`Process exited with code ${value.exit_code}`);
  if (value.session_id !== undefined) lines.push(`Process running with session ID ${value.session_id}`);
  if (value.original_token_count !== undefined) lines.push(`Original token count: ${value.original_token_count}`);
  lines.push("Output:");
  return `${lines.join("\n")}\n${value.output}`;
}

/**
 * Models often cannot put a real control character into a JSON string and
 * send the escape as text (`\n`, `\u0003`). Input with no control
 * characters at all is decoded once; input that already has some is taken
 * as meant.
 */
export function decodeChars(chars) {
  if (!chars.includes("\\") || /[\x00-\x1f]/.test(chars)) return chars;
  return chars.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrte\\])/g, (_, code) => {
    switch (code[0]) {
      case "u":
      case "x":
        return String.fromCharCode(parseInt(code.slice(1), 16));
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "e":
        return "\x1b";
      default:
        return "\\";
    }
  });
}

export function clampYield(requested, { fallback, min, max }) {
  const value = Number.isFinite(requested) ? requested : fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Which session to evict when an agent is at its limit (codex
 * process_id_to_prune_from_meta): the least recently used exited session
 * outside the `protect` most recent, else the least recently used one.
 * `meta` is `[{id, lastUsed, exited, busy}]`; busy sessions are never chosen.
 */
export function pickPruneVictim(meta, protect) {
  const byRecency = [...meta].sort((a, b) => b.lastUsed - a.lastUsed);
  const protectedIds = new Set(byRecency.slice(0, protect).map((m) => m.id));
  const lru = [...meta].sort((a, b) => a.lastUsed - b.lastUsed).filter((m) => !protectedIds.has(m.id) && !m.busy);
  return (lru.find((m) => m.exited) ?? lru[0])?.id;
}

/**
 * Where the command runs: an explicit workdir (relative to the session
 * workspace), else the workspace the sandbox confines to, else the session
 * cwd. Same order as tool-bash so confinement and cwd agree.
 */
export function resolveWorkdir(workdir, agent, workspaceRoot) {
  const base = workspaceRoot ?? agent?.session?.header?.cwd ?? process.cwd();
  if (!workdir) return base;
  return isAbsolute(workdir) ? workdir : join(base, workdir);
}

/**
 * One running (or exited but not yet reported) command.
 *
 * Output is pulled into `pending` (a head/tail window) as it arrives, so a
 * session left alone between polls keeps its first and last output instead
 * of only a tail.
 */
class ExecSession {
  constructor({ id, owner, cmd, cwd, tty, mode, confined, bufferBytes }) {
    Object.assign(this, { id, owner, cmd, cwd, tty, mode, confined });
    this.pending = new HeadTailBuffer(bufferBytes);
    this.diagTail = ""; // last output, for sandbox-denial classification
    this.exit = undefined; // {exitCode, signal} once the process ended
    this.failure = undefined; // spawn/provider error
    this.outputClosed = false;
    this.lastUsed = Date.now();
    this.startedAt = Date.now();
    this.offsets = { stdout: 0, stderr: 0 };
    this.spillPath = undefined;
    this.lock = Promise.resolve();
    this.busy = 0;
    this.waiters = new Set();
  }

  /** Serializes interactions (codex interaction_lock). */
  async withLock(fn) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => (release = resolve));
    this.busy += 1;
    try {
      await previous;
      return await fn();
    } finally {
      this.busy -= 1;
      release();
    }
  }

  notify() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Resolves on the next output/exit notification or after `ms`. */
  changed(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.waiters.add(done);
    });
  }

  record(text) {
    if (!text) return;
    this.diagTail = (this.diagTail + text).slice(-64_000);
  }

  get exited() {
    return this.exit !== undefined || this.failure !== undefined;
  }
}

/** Pipe-mode session: bash's stdout (stderr folded in) via the collect reader. */
class PipeSession extends ExecSession {
  attach(handle) {
    this.handle = handle;
    handle.done.then(
      (outcome) => {
        this.exit = outcome;
        this.outputClosed = true; // done settles after the collected pipes drain
        this.notify();
      },
      (error) => {
        this.failure = error;
        this.outputClosed = true;
        this.notify();
      },
    );
  }

  /** Pulls new bytes from the collect readers into `pending`. */
  pull({ final = false } = {}) {
    for (const stream of ["stdout", "stderr"]) {
      const reader = this.handle.collected?.[stream];
      if (!reader) continue;
      const from = this.offsets[stream];
      const read = reader.readFrom(from);
      let { text, nextOffset } = read;
      if (read.spillPath) this.spillPath = read.spillPath;
      if (nextOffset === from) continue;
      let omitted = 0;
      if (read.lossy) {
        omitted = Math.max(0, nextOffset - from - byteLength(text));
      } else if (!final && text.endsWith("\uFFFD")) {
        // The read may have cut a multi-byte character; leave its bytes for
        // the next read unless the replacement is a genuine invalid byte.
        const kept = text.slice(0, -1);
        const keptBytes = byteLength(kept);
        if (!kept.includes("\uFFFD") && nextOffset - from - keptBytes <= 3) {
          text = kept;
          nextOffset = from + keptBytes;
        }
      }
      this.offsets[stream] = nextOffset;
      this.pending.push(text, { omitted });
      this.record(text);
    }
  }

  async interrupt() {
    // The subprocess seam has no "SIGINT only" verb for pipes; terminate() is
    // TERM then KILL on the whole process range.
    this.handle.terminate();
  }

  async write() {
    throw new Error(STDIN_CLOSED_MESSAGE);
  }

  async terminate() {
    this.handle.terminate();
    await this.handle.waitForExit?.(AbortSignal.timeout(10_000)).catch(() => false);
  }
}

/** PTY session: output arrives as events; input is typed into the terminal. */
class TtySession extends ExecSession {
  attach(term) {
    this.term = term;
    const output = term.output;
    output.setEncoding?.("utf8");
    output.on("data", (chunk) => {
      const text = String(chunk).replace(/\r\n/g, "\n");
      this.pending.push(text);
      this.record(text);
      this.notify();
    });
    const closed = () => {
      this.outputClosed = true;
      this.notify();
    };
    output.on("end", closed);
    output.on("close", closed);
    output.on("error", closed);
    term.done.then(
      (outcome) => {
        this.exit = outcome;
        this.notify();
      },
      (error) => {
        this.failure = error;
        this.outputClosed = true;
        this.notify();
      },
    );
  }

  pull() {}

  async interrupt() {
    await this.term.write(INTERRUPT);
  }

  async write(chars) {
    await this.term.write(chars);
  }

  async terminate() {
    await this.term.terminate().catch(() => {});
  }
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    chunk_id: { type: "string" },
    wall_time_seconds: { type: "number", required: true },
    exit_code: { oneOf: [{ type: "integer" }, { type: "null" }] },
    session_id: { type: "integer" },
    original_token_count: { type: "integer" },
    output: { type: "string", required: true },
    sandbox: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", required: true },
        denied: { type: "boolean", required: true },
        runnerFailed: { type: "boolean" },
      },
    },
  },
};

function execDescription(escalation) {
  const base =
    "Runs a shell command (`bash -c`) and returns its output, or a session ID when it is still running after `yield_time_ms`. " +
    "Use write_stdin with that session_id to poll a long-running command (build, test suite, server) or to type into it (requires `tty: true`). " +
    "The process keeps running between calls until it exits or you send \"\\u0003\" with write_stdin. " +
    "Each call starts a fresh shell: pass `workdir` instead of relying on an earlier `cd`. " +
    "Results start with `Process exited with code N` or `Process running with session ID N`. " +
    "Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way.";
  if (!escalation) return base;
  return (
    base +
    " When a command is denied and a wider mode would let it succeed, retry the exact same command once with " +
    "`sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`; the approval " +
    "prompt that retry raises is how the user consents. Never escalate speculatively. If approval prompts are disabled " +
    "or the escalation is rejected, the denial is final — stop and explain."
  );
}

export const SYSTEM_PROMPT_TEXT = [
  "Running commands: exec_command waits up to `yield_time_ms` (default 30 s) and then returns, so it never blocks on a long command.",
  "- A server or other service that must stay up after you finish (a test or the user connects to it later) needs `detach: true`: background jobs started with `&`, `nohup` or `setsid` are stopped when the session ends.",
  "- A result with `Process running with session ID N` means the command is still going. For builds and test suites, poll it with write_stdin {session_id: N, chars: \"\"} and a long `yield_time_ms` (up to 300000); a poll returns as soon as the command exits. Do not run `sleep` to wait.",
  "- Start servers and watchers with exec_command; the session keeps them running while you run clients or tests in other exec_command calls. Poll the server's session to read its log.",
  "- Commands that prompt for input (REPLs, `npm init`, confirmations) need `tty: true`; then send input with write_stdin, including the trailing \"\\n\". Without tty, stdin is closed: prefer non-interactive flags (`--yes`, `-y`) when they exist.",
  "- Stop sessions you no longer need with write_stdin chars \"\\u0003\".",
  "- Check `Process exited with code N` on every finished command and investigate failures before moving on.",
].join("\n");

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const sandbox = () => ctx.get?.("sandbox");
  // `ctx.sandbox` may not be resolvable yet while plugins apply (it is looked
  // up per call); the policy service is what says this composition confines.
  const escalation = cfg.escalation ?? ctx.sandboxPolicy !== undefined;
  /** owner (Agent or NO_OWNER) -> Map<id, ExecSession> */
  const sessions = new Map();
  const NO_OWNER = { id: "no-owner" };
  const cleanupInstalled = new WeakSet();
  let nextId = cfg.firstSessionId ?? 1000;
  let disposed = false;

  const ownerOf = (exec) => exec.agent ?? NO_OWNER;
  const tableOf = (owner) => {
    let table = sessions.get(owner);
    if (!table) {
      table = new Map();
      sessions.set(owner, table);
    }
    return table;
  };

  const terminateOwner = async (owner) => {
    const table = sessions.get(owner);
    sessions.delete(owner);
    if (!table) return;
    await Promise.allSettled([...table.values()].map((session) => session.terminate()));
  };

  const installOwnerCleanup = (owner) => {
    if (owner === NO_OWNER || cleanupInstalled.has(owner)) return;
    cleanupInstalled.add(owner);
    // The agent's sessions die with the agent (codex: session end).
    owner.ctx?.effect?.(() => () => {
      void terminateOwner(owner);
    }, "unieai-exec owner cleanup");
  };

  const disposeAll = async () => {
    disposed = true;
    await Promise.allSettled([...sessions.keys()].map(terminateOwner));
  };
  if (typeof ctx.effect === "function") ctx.effect(() => disposeAll, "unieai-exec session cleanup");
  else ctx.on?.("dispose", disposeAll);

  /** Codex prune_processes_if_needed, per agent. */
  const pruneIfNeeded = (table) => {
    while (table.size >= cfg.maxSessions) {
      const meta = [...table.values()].map((s) => ({ id: s.id, lastUsed: s.lastUsed, exited: s.exited, busy: s.busy > 0 }));
      const victim = pickPruneVictim(meta, cfg.protectRecent);
      if (victim === undefined) return; // everything is protected or busy: allow a soft overflow
      const session = table.get(victim);
      table.delete(victim);
      void session.terminate();
      ctx.logger?.info?.(`unieai-exec: pruned session ${victim} (${session.cmd})`);
    }
  };

  /**
   * Waits until the deadline, or until the process exited and its output
   * closed (codex collect_output_until_deadline). New output alone does not
   * end the wait; the model asked for this much time.
   */
  const collect = async (session, waitMs, signal) => {
    const deadline = Date.now() + waitMs;
    let postExitDeadline;
    while (true) {
      session.pull();
      if (session.exited && session.outputClosed) break;
      if (signal?.aborted) break;
      const now = Date.now();
      if (now >= deadline) break;
      if (session.exited) {
        postExitDeadline ??= Math.min(deadline, now + cfg.postExitWaitMs);
        if (now >= postExitDeadline) break;
      }
      const until = Math.min(deadline, postExitDeadline ?? Infinity);
      await session.changed(Math.min(cfg.pollIntervalMs, until - now));
    }
    session.pull({ final: session.exited });
    const out = new HeadTailBuffer(cfg.bufferBytes);
    session.pending.drainInto(out);
    return out;
  };

  const aborted = (session) => {
    const error = new HarnessError(
      session && !session.exited
        ? `tool call aborted; the command keeps running as session ${session.id}`
        : "tool call aborted",
      TOOL_ABORTED,
    );
    error.name = "AbortError";
    return error;
  };

  /** Shapes one interaction's result, and retires the session once it has exited. */
  const respond = (session, collected, startedAt, maxOutputTokens, table) => {
    const tokens = Math.min(
      Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.floor(maxOutputTokens) : cfg.maxOutputTokens,
      cfg.maxOutputTokensCap,
    );
    let output = formatOutput(collected.text(), tokens, collected.totalBytes);
    const notices = [];
    if (collected.omittedBytes > 0 && session.spillPath) notices.push(`[full output: ${session.spillPath}]`);
    const value = {
      chunk_id: randomBytes(3).toString("hex"),
      wall_time_seconds: (Date.now() - startedAt) / 1000,
      original_token_count: approxTokens(collected.totalBytes),
      output: "",
    };
    session.lastUsed = Date.now();
    if (session.failure !== undefined) {
      table.delete(session.id);
      throw new Error(`command failed to run: ${session.failure?.message ?? session.failure}`);
    }
    if (session.exit !== undefined) {
      table.delete(session.id);
      const { exitCode, signal } = session.exit;
      value.exit_code = signal ? signalExitCode(signal) : exitCode;
      if (signal) notices.push(`[killed by signal: ${signal}]`);
      if (session.confined) {
        const runnerFailed = classifyRunnerFailure(exitCode, session.diagTail, session.confined.runnerFailureRules ?? []) !== undefined;
        const denied = !runnerFailed && matchesSignature(exitCode, session.diagTail, session.confined.denialSignatures ?? []);
        value.sandbox = { mode: session.mode, denied, ...(runnerFailed ? { runnerFailed } : {}) };
        if (runnerFailed) {
          notices.push(
            `[sandbox: the sandbox runner itself failed under ${session.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
          );
        } else if (denied) {
          notices.push(sandboxDenialMarker(session.mode));
          if (escalation) notices.push(escalationHintMarker("command"));
        }
      }
    } else {
      value.session_id = session.id;
    }
    // A command whose stdout has no final newline (`printf`, a bare hash)
    // otherwise runs into whatever the model prints next, and it cannot see
    // where the value ended.
    if (output && !output.endsWith("\n")) notices.push("[output ended without a newline]");
    if (notices.length) output += `${output && !output.endsWith("\n") ? "\n" : ""}${notices.join("\n")}`;
    value.output = output;
    return value;
  };

  /**
   * A service the task needs running after this session ends (a server the
   * user or a test connects to later). dsh stops every subprocess it owns
   * when it exits — on systemd hosts the whole scope, so `nohup … &` and even
   * `setsid` do not survive — so a detached command is spawned here, outside
   * that lifetime, but through the same sandbox confinement (`argv`).
   * Output goes to a log file; a command that dies at once is reported.
   */
  const launchDetached = async ({ argv, cwd, env, confined, mode }) => {
    const dir = join(tmpdir(), "unieai-exec-detached");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.log`);
    const fd = openSync(log, "a", 0o600);
    let child;
    try {
      child = spawnDetached(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    const early = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), cfg.detachProbeMs);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ error });
      });
    });
    const tail = () => {
      try {
        return readFileSync(log, "utf8").slice(-4_000);
      } catch {
        return "";
      }
    };
    if (early === null) {
      child.unref();
      return {
        running: true,
        output:
          `Started a detached process, PID ${child.pid}. It keeps running after this session ends.\n` +
          `Log: ${log}\nStop it with \`kill ${child.pid}\` when it is no longer needed.\n${tail()}`,
        mode,
        confined,
      };
    }
    if (early.error) throw new Error(`could not start the detached command: ${early.error.message}`);
    return {
      running: false,
      exitCode: early.signal ? signalExitCode(early.signal) : early.code,
      output: `The detached command exited immediately.\nLog: ${log}\n${tail()}`,
      mode,
      confined,
    };
  };

  const spawnSession = async (args, exec) => {
    const owner = ownerOf(exec);
    const standing = ctx.sandboxPolicy?.resolve(exec.agent ? { session: exec.agent.session } : {});
    let mode = standing?.mode ?? "danger-full-access";
    if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
      if (!escalation) throw new Error("sandbox_permissions is not available in this composition");
      mode = await approveEscalation(
        { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: mode, subject: "command" },
        { approver: ctx.get?.("approval"), agent: exec.agent, callId: exec.callId, toolName: "exec_command", signal: exec.signal },
      );
    }
    const tty = args.tty === true;
    if (tty && !cfg.allowTty) throw new Error("tty sessions are disabled in this deployment");
    const cwd = resolveWorkdir(args.workdir, exec.agent, standing?.workspaceRoot);
    const login = args.login ?? cfg.login;
    // Pipes: fold stderr into stdout inside bash so the two stay interleaved;
    // the runner's own stderr (sandbox diagnostics) is still read separately.
    const script = tty ? args.cmd : `exec 2>&1\n${args.cmd}`;
    let argv = ["bash", login ? "-lc" : "-c", script];
    let confined;
    if (mode !== "danger-full-access") {
      const provider = sandbox();
      if (!provider) throw new Error(`sandbox mode "${mode}" requires a ctx.sandbox provider`);
      confined = await provider.confine(argv, { ...standing, mode }, exec.signal);
      argv = confined.argv;
    }
    exec.signal?.throwIfAborted();
    const env = {
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      GH_PAGER: "cat",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      ...(ctx.shellEnv?.collect(exec) ?? {}),
    };
    if (args.detach === true) return { detached: await launchDetached({ argv, cwd, env, confined, mode }) };
    const table = tableOf(owner);
    pruneIfNeeded(table);
    const id = nextId++;
    const common = { id, owner, cmd: args.cmd, cwd, tty, mode, confined, bufferBytes: cfg.bufferBytes };
    let session;
    if (tty) {
      session = new TtySession(common);
      // No tool-call signal: the terminal must outlive this call.
      const term = await ctx.subprocess.spawnTerminal({
        argv,
        cwd,
        env,
        rows: cfg.rows,
        cols: cfg.cols,
        terminalType: cfg.terminalType,
        graceMs: cfg.graceMs,
      });
      session.attach(term);
    } else {
      session = new PipeSession(common);
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        env,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: cfg.bufferBytes, spill: { maxBytes: cfg.spillBytes } },
          stderr: { maxBytes: 64_000 },
        },
        graceMs: cfg.graceMs,
      });
      session.attach(handle);
    }
    // Stored before the first wait so an interrupted call cannot orphan it.
    table.set(id, session);
    installOwnerCleanup(owner);
    if (disposed) void session.terminate();
    return { session, table };
  };

  const execCommand = defineTool({
    name: "exec_command",
    description: execDescription(escalation),
    parameters: {
      cmd: { type: "string", required: true, description: "Shell command to execute." },
      workdir: {
        type: "string",
        description: "Working directory for the command. Defaults to the session workspace; a relative path is resolved against it.",
      },
      tty: {
        type: "boolean",
        description: "True allocates a PTY so write_stdin can type into the command; false or omitted uses plain pipes with stdin closed.",
      },
      yield_time_ms: {
        type: "number",
        description: `Wait before yielding output. Defaults to ${cfg.defaultYieldMs} ms; effective range is ${cfg.minYieldMs}-${cfg.maxYieldMs} ms.`,
      },
      max_output_tokens: {
        type: "number",
        description: `Output token budget. Defaults to ${cfg.maxOutputTokens} tokens.`,
      },
      login: { type: "boolean", description: "True runs bash as a login shell (-l). Defaults to false." },
      detach: {
        type: "boolean",
        description:
          "True starts a long-running service that must keep running after your work ends (a server a test or the user will connect to). " +
          "Its output goes to a log file whose path is returned. Background jobs started with `&`, `nohup` or `setsid` are stopped when the session ends; use this instead.",
      },
      ...(escalation
        ? {
            sandbox_permissions: {
              type: "string",
              enum: [...ESCALATION_TARGETS],
              description:
                "The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.",
            },
            justification: {
              type: "string",
              description: "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.",
            },
          }
        : {}),
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderResponse(value) }],
    },
    presentCall: (args) => ({ card: "terminal", title: args.cmd, ...(args.workdir ? { cwd: args.workdir } : {}) }),
    presentResult: presentExecResult,
    async execute(args, exec) {
      if (!args.cmd.trim()) throw new Error("invalid cmd: expected a non-empty string");
      validateEscalationArgs(args.sandbox_permissions, args.justification);
      if (disposed) throw new Error("unieai-exec is shutting down");
      const startedAt = Date.now();
      if (args.detach === true && args.tty === true) throw new Error("detach and tty cannot be combined");
      const spawned = await spawnSession(args, exec);
      if (spawned.detached) {
        const { detached } = spawned;
        return {
          chunk_id: randomBytes(3).toString("hex"),
          wall_time_seconds: (Date.now() - startedAt) / 1000,
          exit_code: detached.running ? null : detached.exitCode,
          output: detached.output,
        };
      }
      const { session, table } = spawned;
      const waitMs = clampYield(args.yield_time_ms, { fallback: cfg.defaultYieldMs, min: cfg.minYieldMs, max: cfg.maxYieldMs });
      return session.withLock(async () => {
        const collected = await collect(session, waitMs, exec.signal);
        if (exec.signal?.aborted && !session.exited) throw aborted(session);
        return respond(session, collected, startedAt, args.max_output_tokens, table);
      });
    },
  });

  const writeStdin = defineTool({
    name: "write_stdin",
    description:
      "Writes characters to a running exec_command session and returns its recent output. Empty `chars` polls without writing " +
      "and waits until the command exits or `yield_time_ms` passes. \"\\u0003\" (Ctrl-C) interrupts the command. Other input requires a session started with `tty: true`; " +
      "end a line with \"\\n\" to press Enter. Escapes such as \\n and \\u0003 written as plain text are decoded.",
    parameters: {
      session_id: { type: "integer", required: true, description: "Identifier of the running exec_command session." },
      chars: { type: "string", description: "Bytes to write to stdin. Defaults to empty, which polls without writing." },
      yield_time_ms: {
        type: "number",
        description:
          `Wait before yielding output. Non-empty writes default to ${cfg.defaultWriteYieldMs} ms and cap at ${cfg.maxYieldMs} ms; ` +
          `empty polls wait ${cfg.minPollMs}-${cfg.maxPollMs} ms.`,
      },
      max_output_tokens: { type: "number", description: `Output token budget. Defaults to ${cfg.maxOutputTokens} tokens.` },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: renderResponse(value) }],
    },
    // Polls touch only their own session (serialized by its lock).
    isConcurrencySafe: (args) => !args.chars,
    presentCall: (args) => ({
      card: "generic",
      kind: "execute",
      title: args.chars ? `write_stdin ${args.session_id}` : `poll session ${args.session_id}`,
      ...(args.chars ? { rawInput: args.chars } : {}),
    }),
    presentResult: presentExecResult,
    async execute(args, exec) {
      const table = sessions.get(ownerOf(exec));
      const session = table?.get(args.session_id);
      if (!session) throw new Error(`Unknown process id ${args.session_id}`);
      const chars = decodeChars(args.chars ?? "");
      return session.withLock(async () => {
        if (!table.has(session.id)) throw new Error(`Unknown process id ${args.session_id}`);
        const startedAt = Date.now();
        if (chars && !session.exited) {
          if (chars === INTERRUPT) {
            await session.interrupt();
          } else if (!session.tty) {
            throw new Error(STDIN_CLOSED_MESSAGE);
          } else {
            try {
              await session.write(chars);
              // Give the program a moment so its reaction lands in this reply.
              await sleep(cfg.ttyWriteSettleMs);
            } catch (error) {
              if (!session.exited) throw error;
            }
          }
        }
        const waitMs = chars
          ? Math.min(Math.max(Number.isFinite(args.yield_time_ms) ? args.yield_time_ms : cfg.defaultWriteYieldMs, cfg.minYieldMs), cfg.maxYieldMs)
          : clampYield(args.yield_time_ms, { fallback: cfg.minPollMs, min: cfg.minPollMs, max: cfg.maxPollMs });
        const collected = await collect(session, waitMs, exec.signal);
        if (exec.signal?.aborted && !session.exited) throw aborted(session);
        return respond(session, collected, startedAt, args.max_output_tokens, table);
      });
    },
  });

  ctx.systemPrompt.section({
    name: "tool:exec_command",
    order: ctx.systemPrompt.getSectionOrder?.("TOOL_BASH"),
    text: SYSTEM_PROMPT_TEXT,
  });
  ctx.tools.register(execCommand);
  ctx.tools.register(writeStdin);

  // For tests and diagnostics.
  return { sessions, disposeAll };
}

/** Terminal card with the exit pill; failures and polls stay generic. */
function presentExecResult(_args, result) {
  const block = result.content.length === 1 ? result.content[0] : undefined;
  if (block?.type !== "text") return undefined;
  if (result.isError) return { card: "generic", content: [{ type: "text", text: `\`\`\`console\n${block.text}\n\`\`\`` }] };
  const exit = block.text.match(/^Process exited with code (\d+)$/m);
  const body = block.text.replace(/^[\s\S]*?^Output:\n/m, "");
  return { card: "terminal", output: body, ...(exit ? { exitCode: Number(exit[1]) } : {}) };
}
