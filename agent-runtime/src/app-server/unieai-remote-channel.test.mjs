// Copyright (c) 2026 UnieAI. All rights reserved.
// The encrypted session framing: sequence numbers as nonces, end-to-end
// acks, chunking inside the ciphertext, and replay after a reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK_BYTES, createChannel } from "./unieai-remote-channel.mjs";
import { PAIR_PROTOCOL, createHandshake, generateKeyPair, prologueFor, randomBytes } from "./unieai-remote-noise.mjs";

function keys() {
  const host = generateKeyPair();
  const psk = randomBytes(32);
  const prologue = prologueFor("r_t");
  const b = createHandshake({ protocol: PAIR_PROTOCOL, initiator: true, prologue, rs: host.publicKey, psk });
  const h = createHandshake({ protocol: PAIR_PROTOCOL, initiator: false, prologue, s: host, psk });
  h.readMessage(b.writeMessage());
  b.readMessage(h.writeMessage());
  return { browser: b.split(), host: h.split() };
}

/** Two channels joined by a wire the test can cut. */
function pairOfChannels() {
  const cipher = keys();
  const wire = { up: true, toHost: [], toBrowser: [] };
  const got = { host: [], browser: [] };
  const errors = [];
  const browser = createChannel({
    cipher: cipher.browser,
    cid: "c1",
    ackDelayMs: 1,
    sendFrame: (frame) => wire.toHost.push(frame),
    onMessage: (m) => got.browser.push(m),
    onError: (e) => errors.push(e),
  });
  const host = createChannel({
    cipher: cipher.host,
    cid: "c1",
    ackDelayMs: 1,
    sendFrame: (frame) => wire.toBrowser.push(frame),
    onMessage: (m) => got.host.push(m),
    onError: (e) => errors.push(e),
  });
  const pump = () => {
    let moved = true;
    while (moved) {
      moved = false;
      for (const [queue, to] of [[wire.toHost, host], [wire.toBrowser, browser]]) {
        const frames = queue.splice(0);
        if (frames.length) moved = true;
        if (wire.up) for (const frame of frames) to.receive(JSON.parse(JSON.stringify(frame)));
      }
    }
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      pump();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    pump();
  };
  return { browser, host, wire, got, errors, pump, settle };
}

test("messages go both ways, and frames carry only ciphertext", async () => {
  const { browser, host, wire, got, settle } = pairOfChannels();
  browser.send({ id: 1, method: "turn/start", params: { input: [{ type: "text", text: "deploy the secret plan" }] } });
  const [frame] = wire.toHost;
  assert.deepEqual(Object.keys(frame).sort(), ["ack", "b", "cid", "seq", "t"]);
  assert.doesNotMatch(JSON.stringify(frame), /secret plan|turn\/start/);
  await settle();
  host.send({ id: 1, result: { ok: true } });
  await settle();
  assert.equal(got.host[0].params.input[0].text, "deploy the secret plan");
  assert.deepEqual(got.browser, [{ id: 1, result: { ok: true } }]);
  assert.equal(browser.stats().unacked, 0, "acks let the sender drop what was delivered");
  assert.equal(host.stats().unacked, 0);
});

test("a large message is chunked inside the ciphertext and reassembled", async () => {
  const { browser, host, wire, got, settle } = pairOfChannels();
  const big = "x".repeat(CHUNK_BYTES * 3 + 17);
  host.send({ method: "item/completed", params: { text: big } });
  assert.equal(wire.toBrowser.length, 4);
  await settle();
  assert.equal(got.browser[0].params.text, big);
  browser.send({ ok: 1 });
  await settle();
});

test("frames lost while the browser was away are replayed, in order, once", async () => {
  const { browser, host, wire, got, settle } = pairOfChannels();
  host.send({ n: 1 });
  await settle();
  wire.up = false;
  host.send({ n: 2 });
  host.send({ n: 3 });
  await settle();
  assert.deepEqual(got.browser.map((m) => m.n), [1]);
  wire.up = true;
  host.replay();
  host.replay(); // a duplicate replay changes nothing
  await settle();
  assert.deepEqual(got.browser.map((m) => m.n), [1, 2, 3]);
  assert.equal(host.stats().unacked, 0);
  browser.send({ n: "done" });
  await settle();
});

test("a tampered or out-of-order frame is not delivered", async () => {
  const { browser, host, wire, got, errors } = pairOfChannels();
  host.send({ n: 1 });
  host.send({ n: 2 });
  const [first, second] = wire.toBrowser.splice(0);
  browser.receive(second); // a gap: dropped, the replay fills it in
  assert.deepEqual(got.browser, []);
  const forged = { ...first, b: first.b.slice(0, -2) + (first.b.endsWith("A") ? "BB" : "AA") };
  browser.receive(forged);
  assert.deepEqual(got.browser, []);
  assert.equal(errors.length, 1);
  browser.receive(first);
  browser.receive(second);
  assert.deepEqual(got.browser.map((m) => m.n), [1, 2]);
});

test("a peer gone too long overflows the replay buffer instead of growing it", () => {
  const cipher = keys();
  let overflowed = 0;
  const host = createChannel({ cipher: cipher.host, cid: "c1", sendFrame: () => {}, onMessage: () => {}, onOverflow: () => (overflowed += 1) });
  for (let i = 0; i < 4097; i++) host.send({ i });
  assert.equal(overflowed, 1);
  host.close();
});
