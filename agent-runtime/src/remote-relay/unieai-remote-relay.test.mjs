// Copyright (c) 2026 UnieAI. All rights reserved.
// Remote Control end to end inside one process: the uac app-server (with a
// scripted engine), its remote bridge, the reference relay, a TUI-like client
// on the socket, and a browser client — with every frame that crossed the
// relay captured, to check it never carried anything readable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "../app-server/server.mjs";
import { createApprovalBridge } from "../app-server/approval.mjs";
import { connectSocketClient } from "../app-server/unieai-socket-client.mjs";
import { createRemoteClient, parsePairingLink } from "../app-server/unieai-remote-client.mjs";
import { createRemoteBridge, DEFAULT_RELAY_URL, remoteAnswer, remoteInput, resolveRelayUrl } from "../app-server/unieai-remote-bridge.mjs";
import { startRemoteRelay, stubValidator, upstreamValidator } from "./unieai-remote-relay.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, { timeoutMs = 5000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

const PROMPT = "please clean the build directory";
const COMMAND = "rm -rf ./build-artifacts";

/**
 * An engine that streams a sentence, asks to run COMMAND, and reports what
 * it was told — through the same approval bridge the real engines use.
 */
function scriptedEngine() {
  const log = { decisions: [] };
  const factory = ({ emit, request, ids, newItemId }) => {
    const approve = createApprovalBridge({ request, ids, newItemId });
    return {
      history: async () => [],
      send: async (text) => {
        for (const word of ["I ", "will ", "clean ", "it."]) {
          emit("item/agentMessage/delta", { delta: word });
          await wait(2);
        }
        const decision = await approve({ tool: "bash", action: "bash", detail: COMMAND });
        log.decisions.push(decision);
        emit("item/agentMessage/delta", { delta: ` (${decision})` });
        return { text };
      },
    };
  };
  return { log, factory };
}

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "rc-e2e-"));
  writeFileSync(join(home, "unieai.json"), JSON.stringify({ account: "rabi", access_token: "desktop-key", studio_url: "https://agent.example.com" }));
  const frames = [];
  const relay = await startRemoteRelay({ validateHost: stubValidator, onFrame: (direction, frame) => frames.push({ direction, frame }), pingMs: 500 });
  const { log, factory } = scriptedEngine();
  const socketPath = join(home, "s.sock");
  const server = await startAppServer({ socketPath, codexHome: home, version: "9.9.9", createEngineFor: factory });
  const tui = connectSocketClient(socketPath);
  await tui.opened;
  const teardown = async () => {
    tui.close();
    await server.stopRemote();
    await server.close();
    await relay.close();
    rmSync(home, { recursive: true, force: true });
  };
  return { home, frames, relay, server, tui, log, teardown };
}

/** A browser client that answers approvals with `decide` and records everything. */
function browser({ host, psk = null, device = null, decide = null, name = "test phone" }) {
  const seen = { notes: [], asked: [] };
  let answerNow = null;
  const client = createRemoteClient({
    host,
    psk,
    device,
    deviceName: name,
    onNotification: (method, params) => seen.notes.push([method, params]),
    onRequest: (method, params) =>
      new Promise((resolve) => {
        seen.asked.push({ method, params });
        if (decide) resolve(decide(method, params));
        else answerNow = resolve;
      }),
    onPaired: (paired) => (seen.paired = paired),
  });
  return { client, seen, answer: (result) => answerNow?.(result) };
}

test("pair from a link, read a thread, drive a turn, and approve from the browser while a TUI watches", async () => {
  const env = await setup();
  try {
    // The TUI starts the session.
    const { thread } = await env.tui.call("thread/start", { cwd: env.home, approvalPolicy: "on-request" });

    // /remote-control: a pairing link with its secrets in the fragment.
    const started = await env.tui.call("unieai/remote/start", { relayUrl: env.relay.relayUrl });
    assert.equal(started.running, true);
    const linkUrl = new URL(started.link);
    assert.equal(linkUrl.search, "", "nothing secret in the query string");
    const host = parsePairingLink(started.link);
    assert.equal(host.relayUrl, env.relay.relayUrl);

    // The phone opens it and pairs.
    const phone = browser({ host, psk: host.psk });
    await phone.client.connect();
    assert.ok(phone.seen.paired?.deviceId, "the host gave this device an id");
    const devices = JSON.parse(readFileSync(join(env.home, "remote-control", "devices.json"), "utf8")).devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, "test phone");
    assert.equal(statSync(join(env.home, "remote-control", "host.json")).mode & 0o777, 0o600);

    const hello = await phone.client.request("initialize");
    assert.equal(hello.deviceId, phone.seen.paired.deviceId);
    const read = await phone.client.request("thread/read", { threadId: thread.id, includeTurns: true });
    assert.equal(read.thread.id, thread.id);
    await until(async () => (await env.tui.call("unieai/remote/status")).viewers === 1, { what: "one viewer" });

    // The phone starts a turn; both clients watch it stream.
    await phone.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: PROMPT }] });
    // Both are asked; the phone answers first.
    await until(() => phone.seen.asked.length === 1, { what: "the phone to be asked" });
    const tuiAsked = await env.tui.next((m) => m.method === "item/commandExecution/requestApproval");
    assert.equal(tuiAsked.params.command, COMMAND);
    assert.equal(phone.seen.asked[0].params.command, COMMAND);
    phone.answer({ decision: "accept" });

    // The TUI is told its prompt was answered elsewhere, by its own id.
    const resolved = await env.tui.next((m) => m.method === "serverRequest/resolved");
    assert.deepEqual(resolved.params, { threadId: thread.id, requestId: tuiAsked.id });
    // Its late answer changes nothing.
    env.tui.send({ id: tuiAsked.id, result: { decision: "decline" } });
    await until(() => phone.seen.notes.some(([m]) => m === "turn/completed"), { what: "the turn to finish" });
    assert.deepEqual(env.log.decisions, ["accept"], "the first answer won");

    // The streamed items reached the phone, decrypted and in order.
    const deltas = phone.seen.notes.filter(([m]) => m === "item/agentMessage/delta").map(([, p]) => p.delta).join("");
    assert.equal(deltas, "I will clean it. (accept)");
    const prompt = phone.seen.notes.find(([m, p]) => m === "item/completed" && p.item.type === "userMessage");
    assert.ok(JSON.stringify(prompt).includes(PROMPT));
    assert.ok(env.tui.messages.some((m) => m.method === "turn/completed"), "the TUI watched the turn too");

    // A second approval: this time the TUI answers first and the phone is told.
    await phone.client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "again" }] });
    const second = await env.tui.next((m) => m.method === "item/commandExecution/requestApproval" && m.id !== tuiAsked.id);
    await until(() => phone.seen.asked.length === 2, { what: "the phone to be asked again" });
    env.tui.send({ id: second.id, result: { decision: "decline" } });
    await until(() => phone.seen.notes.filter(([m]) => m === "serverRequest/resolved").length === 2, { what: "the phone to be told" });
    await until(() => env.log.decisions.length === 2, { what: "the second decision" });
    assert.deepEqual(env.log.decisions, ["accept", "decline"]);

    // --- What the relay saw: routing metadata and ciphertext, nothing else.
    assert.ok(env.frames.length > 10);
    const secrets = [PROMPT, COMMAND, thread.id, "requestApproval", "turn/start", "agentMessage", "I will", host.psk, host.hostKey, "test phone", phone.seen.paired.deviceId, phone.seen.paired.publicKey];
    const allowed = new Set(["t", "cid", "seq", "ack", "b", "mode", "code", "state"]);
    for (const { frame } of env.frames) {
      const text = JSON.stringify(frame);
      for (const secret of secrets) assert.ok(!text.includes(secret), `the relay saw ${secret} in ${text.slice(0, 120)}`);
      for (const key of Object.keys(frame)) assert.ok(allowed.has(key), `unexpected frame field ${key}`);
      if (frame.b) assert.match(frame.b, /^[A-Za-z0-9_-]+$/, "payloads are opaque base64url");
    }
    const types = new Set(env.frames.map(({ frame }) => frame.t));
    for (const t of ["open", "hs1", "hs2", "d"]) assert.ok(types.has(t), `the relay carried ${t}`);

    await phone.client.close();
  } finally {
    await env.teardown();
  }
});

test("a remote can call nothing outside the whitelist, and cannot widen a turn's permissions", async () => {
  const env = await setup();
  try {
    const { thread } = await env.tui.call("thread/start", { cwd: env.home, sandbox: "read-only", approvalPolicy: "on-request" });
    const started = await env.tui.call("unieai/remote/start", { relayUrl: env.relay.relayUrl });
    const host = parsePairingLink(started.link);
    const phone = browser({ host, psk: host.psk, decide: () => ({ decision: "decline" }) });
    await phone.client.connect();

    for (const method of ["config/read", "fs/readFile", "command/exec", "account/read", "login/start", "thread/shellCommand", "thread/settings/update", "thread/start", "thread/resume", "thread/fork", "unieai/remote/revoke", "unieai/remote/start"]) {
      await assert.rejects(phone.client.request(method, { threadId: thread.id, command: ["id"], path: "/etc/passwd" }), /not available to remote clients/, method);
    }
    await assert.rejects(
      phone.client.request("turn/start", { threadId: thread.id, input: [{ type: "localImage", path: "/etc/passwd" }] }),
      /text or inline images/,
    );
    await phone.client.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "go" }],
      sandboxPolicy: { type: "dangerFullAccess" },
      approvalPolicy: "never",
      permissions: ":danger-full-access",
      cwd: "/",
    });
    const read = await phone.client.request("thread/read", { threadId: thread.id });
    assert.equal(read.thread.cwd, env.home);
    const settings = env.server.handlers._threads.get(thread.id).permissions;
    assert.equal(settings.sandbox, "read-only", "the remote's sandboxPolicy was dropped");
    assert.equal(settings.approval, "ask", "and so was its approvalPolicy");
    await phone.client.close();
  } finally {
    await env.teardown();
  }
});

test("reconnect replays what was missed; a revoked device is refused; a used link cannot pair twice", async () => {
  const env = await setup();
  try {
    const { thread } = await env.tui.call("thread/start", { cwd: env.home });
    const started = await env.tui.call("unieai/remote/start", { relayUrl: env.relay.relayUrl });
    const host = parsePairingLink(started.link);
    const phone = browser({ host, psk: host.psk, decide: () => ({ decision: "accept" }) });
    await phone.client.connect();
    await phone.client.request("thread/read", { threadId: thread.id });

    // The phone's connection drops while a turn streams; nothing is lost.
    phone.client._dropStream();
    await env.tui.call("turn/start", { threadId: thread.id, input: "from the TUI" });
    await until(() => phone.seen.notes.some(([m]) => m === "turn/completed"), { what: "the replayed turn" });
    const deltas = phone.seen.notes.filter(([m]) => m === "item/agentMessage/delta").map(([, p]) => p.delta).join("");
    assert.equal(deltas, "I will clean it. (accept)");

    // The same device reconnects later with IK, no secret needed.
    const device = phone.seen.paired;
    await phone.client.close();
    const again = browser({ host: { ...host }, device });
    await again.client.connect();
    assert.equal((await again.client.request("initialize")).deviceId, device.deviceId);

    // The pairing secret was single use.
    const thief = browser({ host, psk: host.psk });
    await assert.rejects(thief.client.connect(), /pair_failed/);
    await thief.client.close();

    // Revoked: its live session ends and it cannot come back.
    const listed = await env.tui.call("unieai/remote/devices");
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].online, true);
    await env.tui.call("unieai/remote/revoke", { deviceId: device.deviceId });
    await again.client.close();
    const revoked = browser({ host, device });
    await assert.rejects(revoked.client.connect(), /unknown_device/);
    await revoked.client.close();
    assert.equal((await env.tui.call("unieai/remote/devices")).devices.length, 0);

    const stopped = await env.tui.call("unieai/remote/stop");
    assert.equal(stopped.running, false);
  } finally {
    await env.teardown();
  }
});

test("the relay refuses a host it cannot validate, and validates against the origin's own API", async () => {
  const relay = await startRemoteRelay({ validateHost: async () => null });
  try {
    const response = await fetch(`${relay.relayUrl}/host/register`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: JSON.stringify({ protocol: 1, hostId: "h_1" }),
    });
    assert.equal(response.status, 401);
    const join = await fetch(`${relay.relayUrl}/client/join`, { method: "POST", body: JSON.stringify({ roomId: "r_x", joinToken: "y" }) });
    assert.equal(join.status, 404);
  } finally {
    await relay.close();
  }

  const calls = [];
  const fakeFetch = async (url, { headers }) => {
    calls.push([url, headers.authorization]);
    if (url === "https://agent.example.com/api/desktop/me") return new Response(JSON.stringify({ user: { id: "u1" } }));
    if (url === "https://studio.example.com/api/user") return new Response(JSON.stringify({ email: "a@b.c" }));
    return new Response("{}", { status: 401 });
  };
  const validate = upstreamValidator({ allowedOrigins: ["https://agent.example.com", "https://studio.example.com/"], fetch: fakeFetch });
  assert.equal(await validate({ account: "rabi", origin: "https://agent.example.com", token: "k" }), "rabi:u1");
  assert.equal(await validate({ account: "studio", origin: "https://studio.example.com", token: "t" }), "studio:https://studio.example.com:a@b.c");
  assert.equal(await validate({ account: "rabi", origin: "https://evil.example.com", token: "k" }), null, "an origin off the allowlist is never asked");
  assert.deepEqual(calls.map(([url]) => url), ["https://agent.example.com/api/desktop/me", "https://studio.example.com/api/user"]);
});

test("remote input and answers are reduced to what the spec allows", () => {
  assert.deepEqual(remoteInput("hi"), [{ type: "text", text: "hi" }]);
  assert.deepEqual(remoteInput([{ type: "image", url: "data:image/png;base64,AA" }]), [{ type: "image", url: "data:image/png;base64,AA" }]);
  assert.throws(() => remoteInput([{ type: "image", url: "file:///etc/passwd" }]));
  assert.deepEqual(remoteAnswer("item/commandExecution/requestApproval", { decision: "acceptForSession" }), { decision: "acceptForSession" });
  assert.deepEqual(remoteAnswer("item/commandExecution/requestApproval", { decision: { acceptWithExecpolicyAmendment: {} } }), { decision: "decline" });
  assert.deepEqual(remoteAnswer("item/tool/requestUserInput", { answers: { q1: { answers: ["A", 3] } }, extra: 1 }), { answers: { q1: { answers: ["A"] } } });
  assert.equal(resolveRelayUrl({ env: {}, settings: {} }), "https://agent.unieai.com/api/remote");
  assert.equal(resolveRelayUrl({ env: { UNIEAI_REMOTE_RELAY_URL: "https://ava.corp/api/remote/" }, settings: {} }), "https://ava.corp/api/remote");
  assert.equal(resolveRelayUrl({ requested: "http://x/api/remote", env: { UNIEAI_REMOTE_RELAY_URL: "https://y" } }), "http://x/api/remote");
});

test("a relay that answers 404 to register fails start at once, saying where the relay is", async () => {
  const home = mkdtempSync(join(tmpdir(), "uac-remote-404-"));
  try {
    writeFileSync(join(home, "unieai.json"), JSON.stringify({ access_token: "at", studio_url: "https://studio.example" }));
    let calls = 0;
    const fetch404 = async () => {
      calls += 1;
      return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    };
    const bridge = createRemoteBridge({ handlers: {}, codexHome: home, fetch: fetch404, env: {} });
    await assert.rejects(bridge.start(), (error) => {
      assert.match(error.message, /no Remote Control relay at https:\/\/agent\.unieai\.com\/api\/remote \(it answered 404\)/);
      assert.match(error.message, /--relay <URL>/);
      return true;
    });
    assert.equal(calls, 1, "a 404 is not retried");
    assert.equal(bridge.status().running, false);

    const custom = createRemoteBridge({ handlers: {}, codexHome: home, fetch: fetch404, env: {} });
    await assert.rejects(custom.start({ relayUrl: "https://relay.example/api/remote" }), /relay\.example.*check the relay URL/);
    assert.notEqual(DEFAULT_RELAY_URL, "https://relay.example/api/remote");
    await bridge.close?.();
    await custom.close?.();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
