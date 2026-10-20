// Copyright (c) 2026 UnieAI. All rights reserved.
// One driver, many subscribers: notifications reach every client watching a
// thread, approvals go to all of them and the first answer wins, and client
// tools stay with the TUI that owns them however many others touch the thread.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThreadClients } from "./unieai-thread-clients.mjs";
import { createApprovalBridge } from "./approval.mjs";
import { createHandlers, startAppServer } from "./server.mjs";
import { decodeFrames, newClientKey } from "./ws.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * A client as the server sees one: it records what it is sent and holds each
 * request until the test answers it, honouring `signal` and `onId` as the
 * server's per-connection ctx does.
 */
function fakeClient(name, { remote = false } = {}) {
  let nextId = -1;
  const client = {
    name,
    remote,
    closed: false,
    notes: [],
    asked: new Map(), // id -> { method, params, resolve, reject }
    emit: (method, params) => client.notes.push([method, params]),
    request: (method, params, { signal, onId } = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId--;
        client.asked.set(id, { method, params, resolve, reject });
        onId?.(id);
        signal?.addEventListener("abort", () => {
          client.asked.delete(id);
          reject(new Error("withdrawn"));
        });
      }),
    answer(result, id = [...client.asked.keys()][0]) {
      const pending = client.asked.get(id);
      client.asked.delete(id);
      pending.resolve(result);
    },
    fail(error = new Error("cannot show it"), id = [...client.asked.keys()][0]) {
      const pending = client.asked.get(id);
      client.asked.delete(id);
      pending.reject(error);
    },
    resolvedNotes: () => client.notes.filter(([method]) => method === "serverRequest/resolved").map(([, params]) => params),
  };
  return client;
}

test("notifications reach every subscriber", () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  clients.attach(tui, { drive: "claim" });
  clients.attach(phone);
  clients.emit("item/started", { threadId: "t1" });
  assert.deepEqual(tui.notes, [["item/started", { threadId: "t1" }]]);
  assert.deepEqual(phone.notes, [["item/started", { threadId: "t1" }]]);
});

test("an approval goes to every client and the first answer wins", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  clients.attach(tui, { drive: "claim" });
  clients.attach(phone);
  const answer = clients.request("item/commandExecution/requestApproval", { threadId: "t1", command: "rm -rf build" });
  assert.equal(tui.asked.size, 1);
  assert.equal(phone.asked.size, 1);
  const [tuiId] = tui.asked.keys();
  const [phoneId] = phone.asked.keys();

  phone.answer({ decision: "accept" });
  assert.deepEqual(await answer, { decision: "accept" });
  // The TUI's prompt is withdrawn and it is told why, by its own request id.
  assert.equal(tui.asked.size, 0, "the other client's question is withdrawn");
  assert.deepEqual(tui.resolvedNotes(), [{ threadId: "t1", requestId: tuiId }]);
  assert.deepEqual(phone.resolvedNotes(), [{ threadId: "t1", requestId: phoneId }]);
});

test("a later answer from another client changes nothing", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  clients.attach(tui, { drive: true });
  clients.attach(phone);
  // A client that does not honour the withdrawal and answers anyway.
  phone.request = (method, params, { onId } = {}) => {
    onId?.(-9);
    return new Promise((resolve) => setTimeout(() => resolve({ decision: "accept" }), 20));
  };
  const answer = clients.request("item/fileChange/requestApproval", { threadId: "t1" });
  tui.answer({ decision: "decline" });
  assert.deepEqual(await answer, { decision: "decline" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await answer, { decision: "decline" });
});

test("a client that fails or leaves does not answer for the others", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  const laptop = fakeClient("laptop", { remote: true });
  clients.attach(tui, { drive: true });
  clients.attach(phone);
  clients.attach(laptop);
  const answer = clients.request("item/commandExecution/requestApproval", { threadId: "t1" });
  tui.fail();
  phone.closed = true;
  clients.detach(phone);
  await tick();
  laptop.answer({ decision: "acceptForSession" });
  assert.deepEqual(await answer, { decision: "acceptForSession" });
});

test("with nobody left to answer, the request fails closed", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  clients.attach(tui, { drive: true });
  const answer = clients.request("item/commandExecution/requestApproval", { threadId: "t1" });
  tui.closed = true;
  clients.detach(tui);
  await assert.rejects(answer);
  // Nobody watching at all: refused at once.
  await assert.rejects(clients.request("item/commandExecution/requestApproval", { threadId: "t1" }));
  // Through the approval bridge, both are refusals, never approvals.
  const decide = createApprovalBridge({ request: clients.request, ids: () => ({ threadId: "t1", turnId: "u1" }) });
  assert.equal(await decide({ tool: "bash", detail: "ls" }), "decline");
});

test("a client that attaches while a request is open is asked too", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tui = fakeClient("tui");
  clients.attach(tui, { drive: true });
  const answer = clients.request("item/tool/requestUserInput", { threadId: "t1", questions: [] });
  const phone = fakeClient("phone", { remote: true });
  clients.attach(phone);
  assert.equal(phone.asked.size, 1, "the phone opened after the question was asked, and still sees it");
  phone.answer({ answers: { q1: { answers: ["yes"] } } });
  assert.deepEqual(await answer, { answers: { q1: { answers: ["yes"] } } });
  assert.equal(tui.resolvedNotes().length, 1);
});

test("client tools go to the driver only, and a remote never drives", async () => {
  const clients = createThreadClients({ threadId: "t1" });
  const tuiA = fakeClient("a");
  const tuiB = fakeClient("b");
  const phone = fakeClient("phone", { remote: true });
  clients.attach(tuiA, { drive: "claim" });
  clients.attach(tuiB, { drive: true });
  clients.attach(phone, { drive: "claim" });
  assert.equal(clients.driver, tuiA);
  clients.request("item/tool/call", { threadId: "t1", tool: "send_peer_message" });
  assert.equal(tuiA.asked.size, 1);
  assert.equal(tuiB.asked.size, 0);
  assert.equal(phone.asked.size, 0);

  // The driver leaves: the next TUI to act takes over, a remote does not.
  tuiA.closed = true;
  clients.detach(tuiA);
  assert.equal(clients.driver, null);
  await assert.rejects(clients.request("item/tool/call", { threadId: "t1" }), /not connected/);
  clients.attach(phone, { drive: true });
  assert.equal(clients.driver, null);
  clients.attach(tuiB, { drive: true });
  assert.equal(clients.driver, tuiB);
});

// --- The server, end to end over handlers ---------------------------------

/** An engine whose approvals and client tools the test drives. */
function scriptedEngine() {
  const state = { options: null, sent: [], release: null, aborted: false };
  const factory = (options) => {
    state.options = options;
    return {
      configure: async () => {},
      history: async () => [],
      send: (text, { abortSignal } = {}) => {
        state.sent.push(text);
        abortSignal?.addEventListener("abort", () => {
          state.aborted = true;
          state.release?.();
        });
        return new Promise((resolve) => {
          state.release = () => resolve({});
        });
      },
      cancel: () => {},
    };
  };
  return { state, factory };
}

test("the hijack: another TUI resuming and prompting a thread does not take its client tools or approvals away", async () => {
  // TUI A starts the thread and hosts its client tools (the session mesh).
  // TUI B — another window on the same machine — resumes the same thread and
  // sends a turn. The last caller used to become the thread's only client, so
  // A's send_peer_message calls went to B, which answered "the session mesh is
  // not available in this session".
  const { state, factory } = scriptedEngine();
  const handlers = createHandlers({ codexHome: "/h", createEngineFor: factory, interruptGraceMs: 20 });
  const tuiA = fakeClient("a");
  const tuiB = fakeClient("b");
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd(), dynamicTools: [{ name: "send_peer_message" }] }, tuiA);
  await handlers["thread/resume"]({ threadId: thread.id }, tuiB);
  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "from B" }] }, tuiB);

  const toolCall = state.options.request("item/tool/call", { threadId: thread.id, tool: "send_peer_message" });
  assert.equal(tuiA.asked.size, 1, "A, which hosts the tool, is asked");
  assert.equal(tuiB.asked.size, 0, "B is not");
  tuiA.answer({ contentItems: [], success: true });
  assert.deepEqual(await toolCall, { contentItems: [], success: true });

  // Both watch the turn B started.
  for (const client of [tuiA, tuiB]) {
    assert.ok(client.notes.some(([method]) => method === "turn/started"), `${client.name} sees the turn`);
  }
  // An approval goes to both; A answers.
  const approval = state.options.request("item/commandExecution/requestApproval", { threadId: thread.id });
  assert.equal(tuiA.asked.size, 1);
  assert.equal(tuiB.asked.size, 1);
  tuiA.answer({ decision: "accept" });
  assert.deepEqual(await approval, { decision: "accept" });
  assert.equal(tuiB.resolvedNotes().length, 1, "B's prompt is dismissed");
  assert.equal(handlers._threads.get(thread.id).connection.driver, tuiA);

  // A goes away. B resuming now takes over: the tools are B's to host.
  tuiA.closed = true;
  handlers._detach(tuiA);
  await handlers["thread/resume"]({ threadId: thread.id }, tuiB);
  assert.equal(handlers._threads.get(thread.id).connection.driver, tuiB);
  state.release();
});

test("a remote subscriber watches, starts and interrupts turns, and answers approvals", async () => {
  const { state, factory } = scriptedEngine();
  const handlers = createHandlers({ codexHome: "/h", createEngineFor: factory, interruptGraceMs: 20 });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, tui);
  handlers._attach(thread.id, phone);

  await handlers["turn/start"]({ threadId: thread.id, input: [{ type: "text", text: "from the phone" }] }, phone);
  assert.deepEqual(state.sent, ["from the phone"]);
  for (const client of [tui, phone]) {
    const user = client.notes.find(([method, params]) => method === "item/completed" && params.item.type === "userMessage");
    assert.ok(user, `${client.name} sees the prompt`);
  }
  assert.equal(handlers._threads.get(thread.id).connection.driver, tui, "the phone never drives");

  const approval = state.options.request("item/commandExecution/requestApproval", { threadId: thread.id });
  phone.answer({ decision: "accept" });
  assert.deepEqual(await approval, { decision: "accept" });
  assert.equal(tui.asked.size, 0);
  assert.equal(tui.resolvedNotes().length, 1);

  await handlers["turn/interrupt"]({ threadId: thread.id }, phone);
  assert.equal(state.aborted, true);
  await tick();
  assert.ok(tui.notes.some(([method]) => method === "turn/completed"));
  assert.ok(phone.notes.some(([method]) => method === "turn/completed"));
});

test("a question from the model reaches a remote, and nobody left to answer it is no answer", async () => {
  const { state, factory } = scriptedEngine();
  const handlers = createHandlers({ codexHome: "/h", createEngineFor: factory });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, tui);
  handlers._attach(thread.id, phone);
  await handlers["turn/start"]({ threadId: thread.id, input: "go" }, tui);
  const questions = [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }];

  const asked = state.options.askUser({ questions });
  await tick();
  assert.equal(phone.asked.size, 1);
  phone.answer({ answers: { q1: { answers: ["B"] } } });
  assert.deepEqual(await asked, { answers: [{ id: "q1", selected: ["B"] }] });
  assert.equal(tui.resolvedNotes().length, 1, "the TUI's question screen is dismissed");

  const unanswered = state.options.askUser({ questions });
  await tick();
  tui.closed = true;
  phone.closed = true;
  handlers._detach(tui);
  handlers._detach(phone);
  assert.deepEqual(await unanswered, { answers: [{ id: "q1", selected: [] }] });
  state.release();
});

test("one client unsubscribing does not unload a thread another is watching", async () => {
  let closed = 0;
  const handlers = createHandlers({
    codexHome: "/h",
    threadStore: null,
    createEngineFor: () => ({ send: async () => ({}), close: async () => { closed += 1; } }),
  });
  const tui = fakeClient("tui");
  const phone = fakeClient("phone", { remote: true });
  const { thread } = await handlers["thread/start"]({ cwd: process.cwd() }, tui);
  await handlers["turn/start"]({ threadId: thread.id, input: "go" }, tui);
  handlers._attach(thread.id, phone);
  await tick();
  handlers._detach(phone, thread.id);
  phone.notes.length = 0;
  await handlers["turn/start"]({ threadId: thread.id, input: "again" }, tui);
  assert.deepEqual(phone.notes, [], "a detached client hears nothing more");
  assert.equal(closed, 0);
});

// --- Over the socket: two real connections -----------------------------------

/** A minimal websocket client for the server's unix socket. */
function socketClient(socketPath) {
  const socket = connect(socketPath);
  const messages = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  let carry = { opcode: null, chunks: [] };
  let upgraded = false;
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  const frame = (text) => {
    const body = Buffer.from(text);
    const mask = Buffer.from([7, 3, 5, 1]);
    const out = Buffer.from(body);
    for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
    const header = body.length < 126
      ? Buffer.from([0x81, 0x80 | body.length])
      : Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([header, mask, out]);
  };
  socket.on("connect", () => socket.write(`GET / HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${newClientKey()}\r\n\r\n`));
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      buf = buf.subarray(end + 4);
      upgraded = true;
      ready();
    }
    const decoded = decodeFrames(buf, carry);
    buf = decoded.rest;
    carry = decoded.carry;
    for (const f of decoded.frames) {
      const message = JSON.parse(f.data.toString());
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  socket.on("error", () => {});
  return {
    messages,
    opened,
    send: (message) => socket.write(frame(JSON.stringify(message))),
    next: (match) => {
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    close: () => socket.destroy(),
  };
}

test("over the socket: both TUIs are asked, the first answer wins, the other is told", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uac-fanout-"));
  const socketPath = join(dir, "s.sock");
  let decision = null;
  const server = await startAppServer({
    socketPath,
    codexHome: dir,
    version: "0.1.0",
    createEngineFor: ({ request }) => ({
      send: async () => {
        decision = await request("item/commandExecution/requestApproval", { threadId: "x", turnId: "y" });
      },
    }),
  });
  const a = socketClient(socketPath);
  const b = socketClient(socketPath);
  try {
    await Promise.all([a.opened, b.opened]);
    a.send({ id: 1, method: "thread/start", params: { cwd: dir } });
    const started = await a.next((m) => m.id === 1);
    const threadId = started.result.thread.id;
    // B watches the same thread (a second window resuming it).
    b.send({ id: 1, method: "thread/resume", params: { threadId } });
    await b.next((m) => m.id === 1);
    a.send({ id: 2, method: "turn/start", params: { threadId, input: "go" } });
    const askedA = await a.next((m) => m.method === "item/commandExecution/requestApproval");
    const askedB = await b.next((m) => m.method === "item/commandExecution/requestApproval");
    b.send({ id: askedB.id, result: { decision: "accept" } });
    const resolvedA = await a.next((m) => m.method === "serverRequest/resolved");
    assert.deepEqual(resolvedA.params, { threadId, requestId: askedA.id });
    // A's late answer is a response to a request that no longer exists.
    a.send({ id: askedA.id, result: { decision: "decline" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(decision, { decision: "accept" });
  } finally {
    a.close();
    b.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
