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
  // The protocol answers with a whole Turn; a bare id is a malformed response
  // and the client drops the connection over it.
  assert.ok(res.turn?.id, "turn/start returns a Turn");
  assert.equal(res.turn.status, "inProgress", "status is a bare string, not a tagged union");
  assert.equal(res.turn.itemsView, "notLoaded");
  assert.deepEqual(res.turn.items, []);
  await new Promise((r) => setTimeout(r, 10)); // let the detached turn run
  assert.deepEqual(engine.calls, ["fix the bug"]);
  const methods = emitted.map(([m]) => m);
  // The lifecycle the client watches, in the order the Rust server sends it.
  assert.deepEqual(methods.slice(0, 4), [
    "thread/status/changed", "turn/started", "item/started", "item/completed",
  ]);
  assert.ok(methods.includes("turn/completed"), "the turn reports it finished");
  assert.equal(methods.at(-1), "thread/status/changed", "and the thread goes back to idle");
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
  const error = emitted.find(([m]) => m === "error");
  assert.ok(error, "the failure is reported to the client");
  assert.match(error[1].error.message, /gateway down/);
  // Even a failed turn must close its lifecycle, or the client stays "running".
  assert.ok(emitted.some(([m]) => m === "turn/completed"));
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

test("a server-initiated request is answered by the client and routed back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "as-req-"));
  const socketPath = join(dir, "s.sock");
  let capturedRequest = null;
  const server = await startAppServer({
    socketPath, codexHome: dir, version: "0.1.0",
    createEngineFor: ({ request }) => ({
      send: async () => { capturedRequest = await request("item/commandExecution/requestApproval", { callId: "c1" }); },
    }),
  });
  try {
    const { connect } = await import("node:net");
    const { decodeFrames, encodeFrame, newClientKey } = await import("./ws.mjs");
    await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buf = Buffer.alloc(0); let up = false; let carry = { opcode: null, chunks: [] };
      const mask = (text) => {
        const body = Buffer.from(text); const m = Buffer.from([9, 8, 7, 6]);
        const out = Buffer.from(body); for (let i = 0; i < out.length; i++) out[i] ^= m[i % 4];
        return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), m, out]);
      };
      socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n\r\n`));
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!up) {
          const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
          buf = buf.subarray(end + 4); up = true;
          socket.write(mask(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: dir } })));
        }
        const d = decodeFrames(buf, carry); buf = d.rest; carry = d.carry;
        for (const f of d.frames) {
          const msg = JSON.parse(f.data.toString());
          if (msg.id === 1 && msg.result) {
            socket.write(mask(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: msg.result.thread.id, input: "go" } })));
          } else if (msg.method === "item/commandExecution/requestApproval") {
            // The server asked us; answer with its own (negative) id.
            socket.write(mask(JSON.stringify({ id: msg.id, result: { decision: "approved" } })));
            setTimeout(() => { socket.destroy(); resolve(); }, 60);
          }
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timed out")), 4000).unref?.();
    });
    assert.deepEqual(capturedRequest, { decision: "approved" });
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a dropped connection releases a waiting approval instead of hanging the turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "as-drop-"));
  const socketPath = join(dir, "s.sock");
  let answer = null;
  const server = await startAppServer({
    socketPath, codexHome: dir, version: "0.1.0",
    createEngineFor: ({ request }) => ({
      send: async () => { answer = await request("item/commandExecution/requestApproval", { callId: "c1" }); },
    }),
  });
  try {
    const { connect } = await import("node:net");
    const { decodeFrames, newClientKey } = await import("./ws.mjs");
    await new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      let buf = Buffer.alloc(0); let up = false; let carry = { opcode: null, chunks: [] };
      const mask = (text) => {
        const body = Buffer.from(text); const m = Buffer.from([1, 2, 3, 4]);
        const out = Buffer.from(body); for (let i = 0; i < out.length; i++) out[i] ^= m[i % 4];
        return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), m, out]);
      };
      socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n\r\n`));
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!up) { const e = buf.indexOf("\r\n\r\n"); if (e < 0) return; buf = buf.subarray(e + 4); up = true;
          socket.write(mask(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: dir } }))); }
        const d = decodeFrames(buf, carry); buf = d.rest; carry = d.carry;
        for (const f of d.frames) {
          const msg = JSON.parse(f.data.toString());
          if (msg.id === 1 && msg.result) socket.write(mask(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: msg.result.thread.id, input: "go" } })));
          else if (msg.method === "item/commandExecution/requestApproval") { socket.destroy(); setTimeout(resolve, 80); }
        }
      });
      socket.on("error", () => {});
      setTimeout(() => reject(new Error("timed out")), 4000).unref?.();
    });
    // `cancel` is the v2 vocabulary for "stop"; `abort` was the core enum's, and
    // the wire never used it. Either way it must not read as an approval.
    assert.deepEqual(answer, { decision: "cancel" }, "the waiter is released, and not as an approval");
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("handshake notifications are absorbed, not forwarded", async () => {
  // `initialized` belongs to the connection handshake. The stdio app-server has
  // no such method, so forwarding it logged a wall of "unknown variant" noise.
  const forwarded = [];
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  const dispatch = createDispatcher({ handlers: h, fallback: async (m) => { forwarded.push(m); return {}; } });
  assert.equal(await dispatch({ method: "initialized" }), null);
  assert.deepEqual(forwarded, []);
});

test("every turn and item notification carries the ids the client files them by", async () => {
  // Captured from a live session: the Rust server stamps threadId/turnId on every
  // item notification, and the client drops anything it cannot place. It also
  // sends `status` and `itemsView` as bare strings, not tagged unions — reading
  // the generated TypeScript as if they were objects is what broke the TUI twice.
  const engine = fakeEngine();
  const h = createHandlers({ createEngineFor: engine.factory, codexHome: "/h" });
  const emitted = [];
  const ctx = { emit: (m, p) => emitted.push([m, p]) };
  const { thread } = await h["thread/start"]({ cwd: "/repo" }, ctx);
  const { turn } = await h["turn/start"]({ threadId: thread.id, input: "go" }, ctx);
  await new Promise((r) => setTimeout(r, 10));

  for (const [method, params] of emitted) {
    if (!method.startsWith("item/")) continue;
    assert.equal(params.threadId, thread.id, `${method} names its thread`);
    assert.equal(params.turnId, turn.id, `${method} names its turn`);
  }
  const started = emitted.find(([m]) => m === "turn/started")[1];
  assert.equal(typeof started.turn.status, "string");
  assert.equal(typeof started.turn.itemsView, "string");
  assert.equal(typeof started.turn.startedAt, "number");

  const completed = emitted.find(([m]) => m === "turn/completed")[1];
  assert.equal(completed.turn.status, "completed");
  assert.equal(typeof completed.turn.completedAt, "number");
  assert.equal(typeof completed.turn.durationMs, "number");
});

test("streamed answer text names the item it belongs to", async () => {
  // Without `itemId` the client cannot attach a delta to a card and silently
  // drops it — the engine appears to produce nothing, which is what the TUI showed.
  const h = createHandlers({
    createEngineFor: ({ emit }) => ({
      send: async () => { emit("item/agentMessage/delta", { delta: "he" }); emit("item/agentMessage/delta", { delta: "llo" }); },
    }),
    codexHome: "/h",
  });
  const emitted = [];
  const ctx = { emit: (m, p) => emitted.push([m, p]) };
  const { thread } = await h["thread/start"]({}, ctx);
  const { turn } = await h["turn/start"]({ threadId: thread.id, input: "hi" }, ctx);
  await new Promise((r) => setTimeout(r, 10));

  const deltas = emitted.filter(([m]) => m === "item/agentMessage/delta");
  assert.equal(deltas.length, 2);
  for (const [, p] of deltas) {
    assert.ok(p.itemId, "every delta names its item");
    assert.equal(p.threadId, thread.id);
    assert.equal(p.turnId, turn.id);
  }
  // The card must be opened before text streams into it.
  const startedAgent = emitted.find(([m, p]) => m === "item/started" && p.item.type === "agentMessage");
  assert.ok(startedAgent, "an agentMessage item is opened for the answer");
  assert.equal(startedAgent[1].item.id, deltas[0][1].itemId);
  const done = emitted.find(([m, p]) => m === "item/completed" && p.item.type === "agentMessage");
  assert.equal(done[1].item.text, "hello", "the completed item carries the full answer");
});

test("the reported sandbox is the one the engine actually runs under", async () => {
  // The first cut hardcoded readOnly while the engine executed with
  // workspace-write: the client's header promised a restriction that nothing
  // enforced, which is worse than reporting the weaker policy honestly.
  const write = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  const w = await write["thread/start"]({});
  assert.equal(w.sandbox.type, "workspaceWrite");
  assert.equal(w.activePermissionProfile.id, ":workspace-write");

  const ro = createHandlers({ createEngineFor: () => ({}), codexHome: "/h", sandboxMode: "readOnly" });
  const r = await ro["thread/start"]({});
  assert.equal(r.sandbox.type, "readOnly");
  assert.equal(r.sandbox.networkAccess, false);
});

// ── thread-scoped methods ────────────────────────────────────────────────────
// These were forwarded to the Rust child, which keeps threads in its OWN
// in-process map. Every one of them asked a different process about a thread it
// had never heard of.

test("thread-scoped methods are answered here, never forwarded", async () => {
  const forwarded = [];
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  const dispatch = createDispatcher({
    handlers: h,
    fallback: async (method) => { forwarded.push(method); return { ok: true }; },
  });
  for (const method of [
    "turn/steer", "thread/compact/start", "thread/items/list",
    "thread/resume", "thread/fork", "thread/rollback", "review/start",
  ]) {
    await dispatch({ method, id: 1, params: { threadId: "nope" } });
  }
  assert.deepEqual(forwarded, [], "a thread-scoped method reached the wrong process");
});

test("an unimplemented thread method says so rather than answering wrongly", async () => {
  const h = createHandlers({ createEngineFor: () => ({}), codexHome: "/h" });
  for (const method of ["thread/resume", "thread/fork", "thread/rollback", "review/start"]) {
    await assert.rejects(() => h[method]({ threadId: "x" }), /not supported/, method);
  }
});

test("steering reports whether the running turn actually took it", async () => {
  let steered = null;
  const h = createHandlers({
    createEngineFor: () => ({ send: async () => {}, steer: (t) => { steered = t; return true; } }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "go" }, { emit: () => {} });
  assert.deepEqual(await h["turn/steer"]({ threadId: thread.id, input: "actually, do X" }), { delivered: true });
  assert.equal(steered, "actually, do X");
});

test("steering something that cannot take it reports false, not success", async () => {
  // The engine refuses when nothing is running, or when what is running is a
  // compaction. Reporting `delivered: true` would tell the user their message
  // landed somewhere it did not.
  const h = createHandlers({
    createEngineFor: () => ({ send: async () => {}, steer: () => false }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "go" }, { emit: () => {} });
  assert.deepEqual(await h["turn/steer"]({ threadId: thread.id, input: "hello" }), { delivered: false });
});

test("compaction runs on the engine and is announced when it changed something", async () => {
  const emitted = [];
  const h = createHandlers({
    createEngineFor: () => ({ send: async () => {}, compact: async () => true }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "go" }, { emit: () => {} });
  const res = await h["thread/compact/start"]({ threadId: thread.id }, { emit: (m, p) => emitted.push([m, p]) });
  assert.deepEqual(res, { compacted: true });
  assert.ok(emitted.some(([m]) => m === "thread/compacted"));
});

test("listing items returns protocol items, without the engine's synthetic wrappers", async () => {
  const h = createHandlers({
    createEngineFor: () => ({
      send: async () => {},
      messages: [
        { role: "system", content: "you are a coding agent" },
        { role: "user", content: "<project_instructions>AGENTS.md</project_instructions>" },
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "fixed it" },
      ],
    }),
    codexHome: "/h",
  });
  const { thread } = await h["thread/start"]({});
  await h["turn/start"]({ threadId: thread.id, input: "go" }, { emit: () => {} });
  const { items } = await h["thread/items/list"]({ threadId: thread.id });
  const types = items.map((i) => i.type);
  assert.ok(!types.includes("systemMessage"), "there is no such item type");
  // Two user-role messages in, one out: `<project_instructions>` is something
  // the engine injected, not something the user said.
  assert.equal(items.filter((i) => i.type === "userMessage").length, 1, "the injected instructions were shown as the user's words");
  assert.equal(items.find((i) => i.type === "userMessage").content[0].text, "fix the bug");
  assert.ok(items.some((i) => i.type === "agentMessage" && i.text === "fixed it"));
});
