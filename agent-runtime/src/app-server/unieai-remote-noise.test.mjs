// Copyright (c) 2026 UnieAI. All rights reserved.
// The two Noise handshakes Remote Control uses, checked against the
// cacophony test vectors (github.com/haskell-cryptography/cacophony,
// vectors/cacophony.txt), then against what they must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAIR_PROTOCOL,
  RESUME_PROTOCOL,
  createHandshake,
  fromBase64Url,
  generateKeyPair,
  prologueFor,
  randomBytes,
  toBase64Url,
} from "./unieai-remote-noise.mjs";

const hex = (text) => Uint8Array.from(Buffer.from(text, "hex"));
const toHex = (bytes) => Buffer.from(bytes).toString("hex");

// From cacophony.txt, the two protocols used here.
const VECTORS = [
  {
    protocol_name: "Noise_IK_25519_ChaChaPoly_SHA256",
    init_prologue: "4a6f686e2047616c74",
    init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
    init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    init_remote_static: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    handshake_hash: "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7",
    messages: [
      ["4c756477696720766f6e204d69736573", "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944718da798efbcd91528520204f904b9bd6c7413dccdc214d951e15253e39987f18146e8cd0873654207148333479d4d16c289f0294b29960a72f48e0b7bba2e89083169825e59642148d492020664ccf7"],
      ["4d757272617920526f746862617264", "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088435361e70b2ed446e6c9ec387d1d6b3b840f194e373979d241b203c4acafccf5"],
      ["462e20412e20486179656b", "050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8"],
      ["4361726c204d656e676572", "344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667"],
      ["4a65616e2d426170746973746520536179", "62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4"],
      ["457567656e2042f6686d20766f6e2042617765726b", "029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024"],
    ],
  },
  {
    protocol_name: "Noise_NKpsk0_25519_ChaChaPoly_SHA256",
    init_prologue: "4a6f686e2047616c74",
    psk: "54686973206973206d7920417573747269616e20706572737065637469766521",
    init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
    init_remote_static: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
    resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
    resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
    handshake_hash: "1609ef057bdd62c752b5960546a255a78aebff08c5f07ef2adaa1db8350e7077",
    messages: [
      ["4c756477696720766f6e204d69736573", "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944190fec41487219f2069c3ba7b7f9521437045935231f0ed399dfd4baf6bd825b"],
      ["4d757272617920526f746862617264", "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884385010e0c56e886e6da0c69aee7388bcf4000cc357af5ebd11a46a169a3712c"],
      ["462e20412e20486179656b", "4beed26535f1a387c950fab9a162dc613cc5bf84e8a62653130b83"],
      ["4361726c204d656e676572", "ceaffe71ce7f1bf7b080736d62e0579ce5dc1530a36e7df795a4cc"],
      ["4a65616e2d426170746973746520536179", "da927a272831394122d0f2fef3e16ddf0814c4878401135b44b1e23873b45b2929"],
      ["457567656e2042f6686d20766f6e2042617765726b", "4fed2b394fb4dbdc9cf863bc99ebb3397651d27bdd32e40d8f7fed109e46445c0fd66fc3f3"],
    ],
  },
];

for (const vector of VECTORS) {
  test(`${vector.protocol_name} matches the cacophony vector`, () => {
    const prologue = hex(vector.init_prologue);
    const psk = vector.psk ? hex(vector.psk) : null;
    const initiator = createHandshake({
      protocol: vector.protocol_name,
      initiator: true,
      prologue,
      psk,
      s: vector.init_static ? generateKeyPair(hex(vector.init_static)) : null,
      rs: hex(vector.init_remote_static),
      e: generateKeyPair(hex(vector.init_ephemeral)),
    });
    const responder = createHandshake({
      protocol: vector.protocol_name,
      initiator: false,
      prologue,
      psk,
      s: generateKeyPair(hex(vector.resp_static)),
      e: generateKeyPair(hex(vector.resp_ephemeral)),
    });
    const [[p0, c0], [p1, c1], ...transport] = vector.messages;
    assert.equal(toHex(initiator.writeMessage(hex(p0))), c0);
    assert.equal(toHex(responder.readMessage(hex(c0))), p0);
    assert.equal(toHex(responder.writeMessage(hex(p1))), c1);
    assert.equal(toHex(initiator.readMessage(hex(c1))), p1);
    assert.equal(toHex(initiator.handshakeHash), vector.handshake_hash);
    assert.equal(toHex(responder.handshakeHash), vector.handshake_hash);
    if (vector.init_static) assert.equal(toHex(responder.remoteStatic), toHex(generateKeyPair(hex(vector.init_static)).publicKey));

    // Transport messages alternate, each direction counting its own nonces.
    const i = initiator.split();
    const r = responder.split();
    const nonces = { i: 0, r: 0 };
    transport.forEach(([payload, ciphertext], index) => {
      const fromInitiator = index % 2 === 0;
      const [sender, receiver, side] = fromInitiator ? [i, r, "i"] : [r, i, "r"];
      const nonce = nonces[side]++;
      assert.equal(toHex(sender.send.encrypt(nonce, hex(payload))), ciphertext);
      assert.equal(toHex(receiver.receive.decrypt(nonce, hex(ciphertext))), payload);
    });
  });
}

/** A pairing between a fresh browser and a host, as §5.2 runs it. */
function pair({ psk = randomBytes(32), hostPsk = psk, roomId = "r_test", hostRoom = roomId } = {}) {
  const host = generateKeyPair();
  const browser = createHandshake({ protocol: PAIR_PROTOCOL, initiator: true, prologue: prologueFor(roomId), rs: host.publicKey, psk });
  const responder = createHandshake({ protocol: PAIR_PROTOCOL, initiator: false, prologue: prologueFor(hostRoom), s: host, psk: hostPsk });
  return { host, browser, responder };
}

test("a pairing completes and both sides agree on the keys", () => {
  const { browser, responder } = pair();
  const hello = new TextEncoder().encode('{"v":1}');
  assert.deepEqual(responder.readMessage(browser.writeMessage(hello)), hello);
  browser.readMessage(responder.writeMessage());
  const b = browser.split();
  const h = responder.split();
  const secret = new TextEncoder().encode("rm -rf build?");
  assert.deepEqual(h.receive.decrypt(1, b.send.encrypt(1, secret)), secret);
  assert.deepEqual(b.receive.decrypt(7, h.send.encrypt(7, secret)), secret);
});

test("a pairing with the wrong secret, or for another room, fails at the host", () => {
  const wrong = pair({ hostPsk: randomBytes(32) });
  assert.throws(() => wrong.responder.readMessage(wrong.browser.writeMessage()));
  const elsewhere = pair({ hostRoom: "r_other" });
  assert.throws(() => elsewhere.responder.readMessage(elsewhere.browser.writeMessage()));
});

test("a reconnect tells the host which browser it is, and an impostor host cannot answer", () => {
  const host = generateKeyPair();
  const device = generateKeyPair();
  const prologue = prologueFor("r_test");
  const browser = createHandshake({ protocol: RESUME_PROTOCOL, initiator: true, prologue, s: device, rs: host.publicKey });
  const responder = createHandshake({ protocol: RESUME_PROTOCOL, initiator: false, prologue, s: host });
  responder.readMessage(browser.writeMessage());
  assert.deepEqual(responder.remoteStatic, device.publicKey, "the host learns the browser's static key");
  browser.readMessage(responder.writeMessage());

  // A relay holding some other key cannot complete the browser's handshake.
  const fake = createHandshake({ protocol: RESUME_PROTOCOL, initiator: false, prologue, s: generateKeyPair() });
  const again = createHandshake({ protocol: RESUME_PROTOCOL, initiator: true, prologue, s: device, rs: host.publicKey });
  assert.throws(() => fake.readMessage(again.writeMessage()));
});

test("a tampered frame does not decrypt", () => {
  const { browser, responder } = pair();
  responder.readMessage(browser.writeMessage());
  browser.readMessage(responder.writeMessage());
  const b = browser.split();
  const h = responder.split();
  const sealed = b.send.encrypt(3, new TextEncoder().encode("accept"));
  sealed[0] ^= 1;
  assert.throws(() => h.receive.decrypt(3, sealed));
  assert.throws(() => h.receive.decrypt(4, b.send.encrypt(3, new TextEncoder().encode("accept"))), "the nonce is the sequence number");
});

test("base64url round-trips without padding", () => {
  const bytes = randomBytes(77);
  const text = toBase64Url(bytes);
  assert.doesNotMatch(text, /[+/=]/);
  assert.deepEqual(fromBase64Url(text), bytes);
});
