// The engine is injected, so these exercise the protocol contract without a
// gateway: what the daemon probe needs from `initialize`, that a thread is owned
// here rather than in the Rust process, and that a turn reports progress through
// notifications while answering immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandlers, textOf, userAgent, startAppServer } from "./server.mjs";
import { createDispatcher } from "./rpc.mjs";

const fakeEngine = () => {
  const calls = [];
  return {
    calls,
    factory: ({ emit }) => ({
      send: async (text) => {
        calls.push(text);
        emit("item/started", { itemId: "i1" });
        emit("item/completed", { itemId: "i1", text: `handled: ${text}` });
        return { text: "done" };
      },
    }),
  };
};

test("initialize answers what the daemon probe parses", () => {
  // codex-rs/app-server-daemon/src/client.rs splits on '/' and takes the version;
  // a user agent it cannot parse makes the CLI reject the socket outright.
  const ua = userAgent("1.2.3");
  const [originator, rest] = ua.split("/");
  assert.ok(originator.length > 0);
  assert.equal(rest.split(/\s/)[0], "1.2.3");
});

test("initialize reports the platform and codex home", async () => {
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/home/u/.unieai", version: "9.9.9" });
  const res = await h.initialize();
  assert.equal(res.codexHome, "/home/u/.unieai");
  assert.ok(["unix", "windows"].includes(res.platformFamily));
  assert.match(res.userAgent, /9\.9\.9/);
});

test("a thread is created and readable here, not in the Rust process", async () => {
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  const started = await h["thread/start"]({ cwd: "/repo" });
  assert.equal(started.cwd, "/repo");
  assert.ok(started.thread.id);
  const read = await h["thread/read"]({ threadId: started.thread.id });
  assert.equal(read.thread.id, started.thread.id);
});

test("reading an unknown thread is an invalid-params error, not a crash", async () => {
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  await assert.rejects(() => h["thread/read"]({ threadId: "nope" }), /unknown thread/);
});

test("a turn answers immediately and reports progress as notifications", async () => {
  const engine = fakeEngine();
  const h = createHandlers({ createEngineFor: engine.factory, codexHome: "/h" });
  const emitted = [];
  const ctx = { emit: (m, p) => emitted.push([m, p]) };
  const { thread } = await h["thread/start"]({ cwd: "/repo" });
  const res = await h["turn/start"]({ threadId: thread.id, input: "fix the bug" }, ctx);
  assert.ok(res.turnId, "turn/start returns immediately with an id");
  await new Promise((r) => setImmediate(r)); // let the detached turn run
  assert.deepEqual(engine.calls, ["fix the bug"]);
  assert.deepEqual(emitted.map(([m]) => m), ["item/started", "item/completed"]);
});

test("the thread preview is the first thing the user asked", async () => {
  const engine = fakeEngine();
  const h = createHandlers({ createEngineFor: engine.factory, codexHome: "/h" });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "first request" }, { emit: () => {} });
  const read = await h["thread/read"]({ threadId: thread.id });
  assert.equal(read.thread.preview, "first request");
});

test("an engine failure surfaces as an error notification, not an unhandled rejection", async () => {
  const h = createHandlers({
    createEngineFor: () => ({ send: async () => { throw new Error("gateway down"); } }),
    codexHome: "/h",
  });
  const emitted = [];
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "x" }, { emit: (m, p) => emitted.push([m, p]) });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(emitted[0][0], "error");
  assert.match(emitted[0][1].message, /gateway down/);
});

test("interrupting a turn aborts the engine's signal", async () => {
  let seenSignal = null;
  const h = createHandlers({
    createEngineFor: () => ({ send: async (_t, { abortSignal }) => { seenSignal = abortSignal; await new Promise(() => {}); } }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "long job" }, { emit: () => {} });
  await h["turn/interrupt"]({ threadId: thread.id });
  assert.equal(seenSignal.aborted, true);
});

test("textOf accepts the shapes the protocol uses for input", () => {
  assert.equal(textOf("plain"), "plain");
  assert.equal(textOf({ text: "wrapped" }), "wrapped");
  assert.equal(textOf([{ text: "a" }, { text: "b" }]), "a\nb");
  assert.equal(textOf(["a", "b"]), "a\nb");
});

test("platform methods are forwarded, engine methods are not", async () => {
  const forwarded = [];
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  const dispatch = createDispatcher({
    handlers: h,
    fallback: async (method) => { forwarded.push(method); return { ok: true }; },
  });
  await dispatch({ method: "fs/readFile", id: 1, params: {} });
  await dispatch({ method: "account/read", id: 2, params: {} });
  await dispatch({ method: "initialize", id: 3, params: {} });
  assert.deepEqual(forwarded, ["fs/readFile", "account/read"]);
});

test("the server listens on the socket the CLI probes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  const socketPath = join(dir, "app-server-control.sock");
  const server = await startAppServer({
    socketPath,
    codexHome: dir,
    version: "0.1.0",
    createEngineFor: () => ({ send: async () => ({}) }),
  });
  try {
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(socketPath), "socket file exists for the CLI to find");
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
