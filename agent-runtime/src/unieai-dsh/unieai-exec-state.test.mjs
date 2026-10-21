// Copyright (c) 2026 UnieAI. All rights reserved.
// The registry of exec sessions left running (uac-plugins/unieai-exec-state),
// and the handle unieai-exec publishes there: what the client's task list
// reads (`peek`) and stops (`kill`) without taking the model's output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "./uac-plugins/unieai-exec.mjs";
import { backgroundSessions, onBackground, publishBackground, retireBackground } from "./uac-plugins/unieai-exec-state.mjs";

/** A collect-mode reader over a growing byte stream (dsh-subprocess-local's shape). */
class FakeReader {
  constructor() {
    this.bytes = Buffer.alloc(0);
  }
  push(text) {
    this.bytes = Buffer.concat([this.bytes, Buffer.from(text)]);
  }
  readFrom(from) {
    return { text: this.bytes.subarray(from).toString("utf8"), nextOffset: this.bytes.length, lossy: false };
  }
}

function fakeProcess() {
  let settle;
  const proc = { stdout: new FakeReader(), stderr: new FakeReader(), terminated: 0 };
  proc.done = new Promise((resolve) => (settle = resolve));
  proc.exit = (exitCode, signal = null) => settle({ exitCode, signal });
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

function setup() {
  const tools = new Map();
  const spawned = [];
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section() {}, getSectionOrder: () => 1000 },
    shellEnv: { collect: () => ({}) },
    get: () => undefined,
    subprocess: {
      spawn(spec) {
        const proc = fakeProcess();
        proc.spec = spec;
        spawned.push(proc);
        return proc.handle;
      },
    },
    effect() {},
  };
  apply(ctx, { defaultYieldMs: 50, minYieldMs: 20, maxYieldMs: 1_000, pollIntervalMs: 5, postExitWaitMs: 20, noticeSettleMs: 5 });
  const agent = { id: "s1", session: { header: { cwd: "/work" } }, ctx: { effect() {} } };
  const run = (tool, args) => tools.get(tool).execute(args, { agent, callId: "c1", signal: new AbortController().signal });
  return { agent, run, spawned };
}

test("the registry: one entry per session, observers told once, retired on request", () => {
  const agent = {};
  const seen = [];
  const unsubscribe = onBackground((owner, handle) => seen.push([owner, handle.id]));
  const broken = onBackground(() => {
    throw new Error("an observer's failure is its own");
  });
  publishBackground(agent, { id: 1 });
  publishBackground(agent, { id: 1 });
  publishBackground(agent, { id: 2 });
  assert.deepEqual(seen, [[agent, 1], [agent, 2]]);
  assert.deepEqual(backgroundSessions(agent).map((handle) => handle.id), [1, 2]);
  retireBackground(agent, 1);
  assert.deepEqual(backgroundSessions(agent).map((handle) => handle.id), [2]);
  assert.deepEqual(backgroundSessions({}), []);
  unsubscribe();
  broken();
});

test("a backgrounded session's handle: its directory, last output without taking the model's, and a stop", async () => {
  const published = [];
  const unsubscribe = onBackground((owner, handle) => published.push([owner, handle]));
  try {
    const { agent, run, spawned } = setup();
    const first = run("exec_command", { cmd: "sleep 120", yield_time_ms: 20 });
    // Output arrives while the call waits.
    setTimeout(() => spawned[0].stdout.push("tick 1\n"), 5);
    const value = await first;
    assert.equal(value.exit_code, undefined, "still running");
    const [owner, handle] = published.find(([candidate]) => candidate === agent);
    assert.equal(handle.cmd, "sleep 120");
    assert.equal(handle.cwd, "/work");
    assert.equal(handle.running, true);
    assert.equal(handle.exitCode, null);
    assert.equal(handle.killed, false);
    assert.equal(owner, agent);

    // A peek shows the latest output and leaves the unread part for the model.
    spawned[0].stdout.push("tick 2\n");
    assert.equal(handle.peek(), "tick 1\ntick 2\n");
    assert.equal(handle.peek(7), "tick 2\n", "bounded to the last bytes");
    const poll = await run("write_stdin", { session_id: value.session_id, chars: "", yield_time_ms: 20 });
    assert.match(poll.output, /tick 2/);

    await handle.kill();
    assert.equal(spawned[0].terminated, 1);
    assert.equal(await handle.whenExited(1_000), true);
    assert.equal(handle.running, false);
    assert.equal(handle.killed, true);
    assert.equal(handle.exitCode, 143, "SIGTERM, as a shell reports it");
  } finally {
    unsubscribe();
  }
});
