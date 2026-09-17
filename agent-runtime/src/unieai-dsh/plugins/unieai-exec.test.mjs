// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-exec.test.mjs — the exec plugin against a fake dsh context.
 *
 * The fake subprocess seam behaves like dsh-subprocess-local where it
 * matters: a byte-offset collect reader that keeps a bounded tail, a `done`
 * that settles after output, and a PTY whose output is an event stream.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  HeadTailBuffer,
  STDIN_CLOSED_MESSAGE,
  SYSTEM_PROMPT_TEXT,
  apply,
  clampYield,
  decodeChars,
  formatOutput,
  pickPruneVictim,
  renderResponse,
  resolveWorkdir,
  truncateMiddle,
} from "./unieai-exec.mjs";

/** A collect-mode reader over a growing byte stream with a bounded tail. */
class FakeReader {
  constructor(maxBytes = 1 << 20) {
    this.maxBytes = maxBytes;
    this.bytes = Buffer.alloc(0);
    this.total = 0;
  }
  push(text) {
    const chunk = Buffer.from(text);
    this.total += chunk.length;
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > this.maxBytes) this.bytes = this.bytes.subarray(this.bytes.length - this.maxBytes);
  }
  readFrom(from) {
    const windowStart = this.total - this.bytes.length;
    const lossy = from < windowStart;
    return {
      text: (lossy ? this.bytes : this.bytes.subarray(from - windowStart)).toString("utf8"),
      nextOffset: this.total,
      lossy,
    };
  }
}

function fakeProcess() {
  let settle;
  const proc = {
    stdout: new FakeReader(),
    stderr: new FakeReader(),
    terminated: 0,
    done: new Promise((resolve) => (settle = resolve)),
    exit(exitCode, signal = null) {
      settle({ exitCode, signal });
    },
  };
  proc.handle = {
    collected: { stdout: proc.stdout, stderr: proc.stderr },
    done: proc.done,
    terminate() {
      proc.terminated += 1;
      proc.exit(null, "SIGTERM");
    },
    waitForExit: async () => true,
  };
  return proc;
}

function fakeTerminal() {
  let settle;
  const output = new PassThrough();
  const term = {
    output,
    written: [],
    done: new Promise((resolve) => (settle = resolve)),
    async write(data) {
      term.written.push(data);
      term.onInput?.(data);
    },
    async terminate() {
      output.end();
      settle({ exitCode: null, signal: "SIGKILL" });
    },
    exit(code) {
      output.end();
      settle({ exitCode: code, signal: null });
    },
  };
  return term;
}

const FAST = {
  defaultYieldMs: 200,
  minYieldMs: 20,
  maxYieldMs: 1_000,
  minPollMs: 50,
  maxPollMs: 2_000,
  pollIntervalMs: 10,
  ttyWriteSettleMs: 5,
};

function setup(config = {}, { mode = "workspace-write", sandbox = true } = {}) {
  const tools = new Map();
  const sections = [];
  const spawned = [];
  const terminals = [];
  const confines = [];
  const disposers = [];
  const agentDisposers = [];
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: (s) => sections.push(s), getSectionOrder: () => 1000 },
    shellEnv: { collect: () => ({ DSH_SESSION_ID: "s1" }) },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: "/work", sessionId: "s1" }) },
    get(name) {
      if (name === "sandbox" && sandbox) {
        return {
          async confine(argv, policy) {
            confines.push({ argv, policy });
            return { argv: ["sbx", "--", ...argv], enforcement: "full", denialSignatures: ["permission denied"], runnerFailureRules: [] };
          },
        };
      }
      return undefined;
    },
    subprocess: {
      spawn(spec) {
        const proc = fakeProcess();
        proc.spec = spec;
        spawned.push(proc);
        return proc.handle;
      },
      async spawnTerminal(spec) {
        const term = fakeTerminal();
        term.spec = spec;
        terminals.push(term);
        return term;
      },
    },
    effect(fn) {
      disposers.push(fn());
    },
  };
  const api = apply(ctx, { ...FAST, ...config });
  const agent = {
    session: { header: { cwd: "/work" } },
    ctx: { effect: (fn) => agentDisposers.push(fn()) },
  };
  const run = (tool, args, extra = {}) =>
    tools.get(tool).execute(args, { agent, callId: "c1", signal: new AbortController().signal, ...extra });
  return { ctx, api, tools, sections, spawned, terminals, confines, disposers, agentDisposers, agent, run };
}

const text = (tools, name, value) => tools.get(name).output.render({}, value)[0].text;

test("truncateMiddle keeps head and tail with a codex marker", () => {
  const input = "a".repeat(100) + "b".repeat(100);
  const out = truncateMiddle(input, 10); // 40 bytes
  assert.ok(out.startsWith("a".repeat(20)));
  assert.ok(out.endsWith("b".repeat(20)));
  assert.match(out, /…40 tokens truncated…/);
  assert.equal(truncateMiddle("short", 10), "short");
});

test("truncateMiddle never splits multi-byte characters", () => {
  const out = truncateMiddle("é".repeat(50), 5);
  assert.ok(!out.includes("�"));
  assert.ok(Buffer.byteLength(out.replace(/…\d+ tokens truncated…/, "")) <= 20);
});

test("formatOutput adds the truncation warning with the original size", () => {
  const input = "line\n".repeat(1000);
  const out = formatOutput(input, 100, 10_000);
  assert.match(out, /^Warning: truncated output \(original token count: 2500\)\nTotal output lines: 1000\n\n/);
  assert.ok(Buffer.byteLength(out) < 600);
  assert.equal(formatOutput("ok\n", 100), "ok\n");
});

test("HeadTailBuffer keeps the first and last halves", () => {
  const buffer = new HeadTailBuffer(20);
  for (let i = 0; i < 10; i += 1) buffer.push(`${i}xxxx`);
  assert.equal(buffer.totalBytes, 50);
  assert.equal(buffer.omittedBytes, 30);
  assert.equal(buffer.text(), "0xxxx1xxxx\n... 30 bytes omitted ...\n8xxxx9xxxx");
  const out = new HeadTailBuffer(100);
  buffer.drainInto(out);
  assert.ok(buffer.empty);
  assert.equal(out.totalBytes, 50);
  assert.equal(out.omittedBytes, 30);
});

test("clampYield and resolveWorkdir", () => {
  assert.equal(clampYield(undefined, { fallback: 10_000, min: 250, max: 30_000 }), 10_000);
  assert.equal(clampYield(1, { fallback: 10_000, min: 250, max: 30_000 }), 250);
  assert.equal(clampYield(99_999, { fallback: 10_000, min: 250, max: 30_000 }), 30_000);
  assert.equal(resolveWorkdir(undefined, null, "/ws"), "/ws");
  assert.equal(resolveWorkdir("sub", null, "/ws"), "/ws/sub");
  assert.equal(resolveWorkdir("/abs", null, "/ws"), "/abs");
});

test("renderResponse mirrors the codex header", () => {
  assert.equal(
    renderResponse({ chunk_id: "abc123", wall_time_seconds: 1.5, exit_code: 0, original_token_count: 1, output: "hi" }),
    "Chunk ID: abc123\nWall time: 1.5000 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nhi",
  );
  assert.match(renderResponse({ wall_time_seconds: 0, session_id: 1001, output: "" }), /Process running with session ID 1001\n/);
});

test("pickPruneVictim prefers old exited sessions and protects recent and busy ones", () => {
  const meta = [
    { id: 1, lastUsed: 1, exited: false },
    { id: 2, lastUsed: 2, exited: true },
    { id: 3, lastUsed: 3, exited: false },
    { id: 4, lastUsed: 4, exited: true },
  ];
  assert.equal(pickPruneVictim(meta, 1), 2);
  assert.equal(pickPruneVictim(meta.map((m) => ({ ...m, exited: false })), 1), 1);
  assert.equal(pickPruneVictim([{ ...meta[0], busy: true }, ...meta.slice(1)], 3), undefined);
  assert.equal(pickPruneVictim(meta, 4), undefined);
});

test("registers both tools and the long-running prompt section", () => {
  const { tools, sections } = setup();
  assert.deepEqual([...tools.keys()], ["exec_command", "write_stdin"]);
  assert.equal(sections[0].name, "tool:exec_command");
  assert.equal(sections[0].text, SYSTEM_PROMPT_TEXT);
  assert.ok(tools.get("exec_command").parameters.properties.sandbox_permissions);
  assert.equal(tools.get("exec_command").parameters.required[0], "cmd");
});

test("a quick command returns its exit code before the yield time", async () => {
  const { run, spawned, confines, tools } = setup({ defaultYieldMs: 5_000 });
  const started = Date.now();
  const pending = run("exec_command", { cmd: "echo hi" });
  await new Promise((r) => setTimeout(r, 20));
  const proc = spawned[0];
  proc.stdout.push("hi\n");
  proc.exit(0);
  const value = await pending;
  assert.ok(Date.now() - started < 1_000, "returned early on exit");
  assert.equal(value.exit_code, 0);
  assert.equal(value.session_id, undefined);
  assert.equal(value.output, "hi\n");
  assert.deepEqual(value.sandbox, { mode: "workspace-write", denied: false });
  // Confined bash, stderr folded, stdin closed, managed env.
  assert.deepEqual(confines[0].argv, ["bash", "-c", "exec 2>&1\necho hi"]);
  assert.equal(proc.spec.argv[0], "sbx");
  assert.equal(proc.spec.stdio.stdin, "ignore");
  assert.equal(proc.spec.cwd, "/work");
  assert.equal(proc.spec.env.DSH_SESSION_ID, "s1");
  assert.equal(proc.spec.env.PAGER, "cat");
  assert.equal(proc.spec.signal, undefined, "the tool-call signal must not own the process");
  assert.match(text(tools, "exec_command", value), /Process exited with code 0\nOriginal token count: 1\nOutput:\nhi\n$/);
});

test("a long command yields a session id after yield_time_ms, then a poll waits for exit", async () => {
  const { run, spawned } = setup();
  const t0 = Date.now();
  const first = await run("exec_command", { cmd: "sleep 40", yield_time_ms: 100 });
  const waited = Date.now() - t0;
  assert.ok(waited >= 95 && waited < 600, `waited ${waited}ms`);
  assert.equal(first.session_id, 1000);
  assert.equal(first.exit_code, undefined);

  // Output alone does not end a poll early; exit does.
  const t1 = Date.now();
  const poll = run("write_stdin", { session_id: 1000, yield_time_ms: 1_500 });
  setTimeout(() => spawned[0].stdout.push("progress\n"), 30);
  setTimeout(() => {
    spawned[0].stdout.push("done\n");
    spawned[0].exit(3);
  }, 200);
  const second = await poll;
  const polled = Date.now() - t1;
  assert.ok(polled >= 190 && polled < 1_000, `polled ${polled}ms`);
  assert.equal(second.exit_code, 3);
  assert.equal(second.output, "progress\ndone\n");
  await assert.rejects(run("write_stdin", { session_id: 1000 }), /Unknown process id 1000/);
});

test("empty polls are clamped to the minimum poll window", async () => {
  const { run } = setup({ minPollMs: 150 });
  await run("exec_command", { cmd: "server", yield_time_ms: 20 });
  const t0 = Date.now();
  const value = await run("write_stdin", { session_id: 1000, chars: "", yield_time_ms: 1 });
  assert.ok(Date.now() - t0 >= 145);
  assert.equal(value.session_id, 1000);
  assert.equal(value.output, "");
});

test("a pipe session rejects input but accepts an interrupt", async () => {
  const { run, spawned } = setup();
  await run("exec_command", { cmd: "cat", yield_time_ms: 20 });
  await assert.rejects(run("write_stdin", { session_id: 1000, chars: "hello\n" }), new RegExp(STDIN_CLOSED_MESSAGE));
  const value = await run("write_stdin", { session_id: 1000, chars: "" });
  assert.equal(spawned[0].terminated, 1);
  assert.equal(value.exit_code, 143);
  assert.match(value.output, /\[killed by signal: SIGTERM\]/);
});

test("decodeChars turns escapes written as text into control characters", () => {
  assert.equal(decodeChars("\\u0003"), "\u0003");
  assert.equal(decodeChars("alice\\n"), "alice\n");
  assert.equal(decodeChars("\\x1b[A\\r\\t\\\\"), "\x1b[A\r\t\\");
  assert.equal(decodeChars("keep \\q"), "keep \\q");
  // Real control characters mean the text is already what was meant.
  assert.equal(decodeChars("a\\nb\n"), "a\\nb\n");
  assert.equal(decodeChars("plain"), "plain");
});

test("an interrupt written as escape text still interrupts a pipe session", async () => {
  const { run, spawned } = setup();
  await run("exec_command", { cmd: "server", yield_time_ms: 20 });
  const value = await run("write_stdin", { session_id: 1000, chars: "\\u0003" });
  assert.equal(spawned[0].terminated, 1);
  assert.equal(value.exit_code, 143);
});

test("tty sessions type into a PTY", async () => {
  const { run, terminals, confines } = setup();
  const first = await run("exec_command", { cmd: "python3", tty: true, yield_time_ms: 20 });
  assert.equal(first.session_id, 1000);
  const term = terminals[0];
  assert.deepEqual(confines[0].argv, ["bash", "-c", "python3"]);
  assert.equal(term.spec.terminalType, "dumb");
  assert.equal(term.spec.signal, undefined);
  term.onInput = (data) => term.output.write(`>>> ${data.replace(/\n/, "\r\n")}2\r\n`);
  const reply = await run("write_stdin", { session_id: 1000, chars: "1+1\n", yield_time_ms: 50 });
  assert.deepEqual(term.written, ["1+1\n"]);
  assert.equal(reply.output, ">>> 1+1\n2\n");
  assert.equal(reply.session_id, 1000);
  setTimeout(() => term.exit(0), 20);
  const last = await run("write_stdin", { session_id: 1000, chars: "exit()\n", yield_time_ms: 1_000 });
  assert.equal(last.exit_code, 0);
});

test("sandbox denials are marked with the dsh vocabulary", async () => {
  const { run, spawned } = setup();
  const pending = run("exec_command", { cmd: "touch /etc/x" });
  await new Promise((r) => setTimeout(r, 10));
  spawned[0].stdout.push("touch: cannot touch '/etc/x': Permission denied\n");
  spawned[0].exit(1);
  const value = await pending;
  assert.equal(value.sandbox.denied, true);
  assert.match(value.output, /\[sandbox: file access denied under workspace-write mode\]/);
});

test("danger-full-access skips confinement", async () => {
  const { run, spawned, confines } = setup({}, { mode: "danger-full-access" });
  const pending = run("exec_command", { cmd: "true" });
  await new Promise((r) => setTimeout(r, 10));
  spawned[0].exit(0);
  const value = await pending;
  assert.equal(confines.length, 0);
  assert.equal(spawned[0].spec.argv[0], "bash");
  assert.equal(value.sandbox, undefined);
});

test("large output is truncated to the token budget", async () => {
  const { run, spawned } = setup();
  const pending = run("exec_command", { cmd: "seq", max_output_tokens: 50 });
  await new Promise((r) => setTimeout(r, 10));
  spawned[0].stdout.push("x".repeat(5_000));
  spawned[0].exit(0);
  const value = await pending;
  assert.equal(value.original_token_count, 1250);
  assert.match(value.output, /^Warning: truncated output \(original token count: 1250\)/);
  assert.ok(Buffer.byteLength(value.output) < 400);
});

test("a cancelled call leaves the process running under its session id", async () => {
  const { run, spawned } = setup();
  const controller = new AbortController();
  const pending = run("exec_command", { cmd: "server", yield_time_ms: 1_000 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, /keeps running as session 1000/);
  assert.equal(spawned[0].terminated, 0);
  spawned[0].stdout.push("still here\n");
  const value = await run("write_stdin", { session_id: 1000, yield_time_ms: 50 });
  assert.equal(value.session_id, 1000);
  assert.equal(value.output, "still here\n");
});

test("sessions belong to their agent", async () => {
  const { run, tools } = setup();
  await run("exec_command", { cmd: "server", yield_time_ms: 20 });
  const other = { session: { header: {} }, ctx: { effect() {} } };
  await assert.rejects(
    tools.get("write_stdin").execute({ session_id: 1000 }, { agent: other, signal: new AbortController().signal }),
    /Unknown process id 1000/,
  );
});

test("the session limit prunes least recently used sessions", async () => {
  const { run, spawned, api, agent } = setup({ maxSessions: 3, protectRecent: 1 });
  for (let i = 0; i < 3; i += 1) await run("exec_command", { cmd: `s${i}`, yield_time_ms: 20 });
  // Touch 1000 so 1001 becomes the least recently used live session.
  await run("write_stdin", { session_id: 1000, yield_time_ms: 1 });
  await run("exec_command", { cmd: "s3", yield_time_ms: 20 });
  const ids = [...api.sessions.get(agent).keys()].sort();
  assert.deepEqual(ids, [1000, 1002, 1003]);
  assert.equal(spawned[1].terminated, 1);
  assert.equal(spawned[0].terminated, 0);

  // An exited, unreported session goes before any live one.
  spawned[2].exit(0);
  await new Promise((r) => setTimeout(r, 5));
  await run("write_stdin", { session_id: 1003, yield_time_ms: 1 });
  await run("exec_command", { cmd: "s4", yield_time_ms: 20 });
  assert.deepEqual([...api.sessions.get(agent).keys()].sort(), [1000, 1003, 1004]);
});

test("agent and plugin disposal terminate sessions", async () => {
  const { run, spawned, terminals, disposers, agentDisposers, api } = setup();
  await run("exec_command", { cmd: "a", yield_time_ms: 20 });
  await run("exec_command", { cmd: "b", tty: true, yield_time_ms: 20 });
  assert.equal(agentDisposers.length, 1, "one cleanup per agent");
  agentDisposers[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(spawned[0].terminated, 1);
  assert.equal(api.sessions.size, 0);
  await terminals[0].done;

  await run("exec_command", { cmd: "c", yield_time_ms: 20 });
  await disposers[0]();
  assert.equal(spawned[1].terminated, 1);
  await assert.rejects(run("exec_command", { cmd: "d" }), /shutting down/);
});

test("a read that ends mid-character waits for the rest", async () => {
  const { run, spawned } = setup();
  await run("exec_command", { cmd: "x", yield_time_ms: 20 });
  const reader = spawned[0].stdout;
  const bytes = Buffer.from("é");
  reader.total += 1;
  reader.bytes = Buffer.concat([reader.bytes, bytes.subarray(0, 1)]);
  await run("write_stdin", { session_id: 1000, yield_time_ms: 1 }).then((v) => assert.equal(v.output, ""));
  reader.total += 1;
  reader.bytes = Buffer.concat([reader.bytes, bytes.subarray(1)]);
  const value = await run("write_stdin", { session_id: 1000, yield_time_ms: 1 });
  assert.equal(value.output, "é");
});

test("escalation goes through approval before spawning", async () => {
  const { run, tools } = setup();
  // No approver is registered: fail closed, nothing spawned.
  await assert.rejects(
    run("exec_command", { cmd: "touch /etc/x", sandbox_permissions: "danger-full-access", justification: "needs /etc" }),
  );
  await assert.rejects(run("exec_command", { cmd: "x", sandbox_permissions: "danger-full-access" }), /justification/);
  assert.ok(tools);
});

