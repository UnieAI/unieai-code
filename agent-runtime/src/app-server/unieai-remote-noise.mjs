// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-noise.mjs — the Noise handshakes Remote Control uses, for the
 * host and the browser alike.
 *
 * docs/unieai/remote-control-protocol.md §5: a browser pairs with
 * `Noise_NKpsk0_25519_ChaChaPoly_SHA256` (it knows the host's static key and
 * the pairing secret from the link) and reconnects with
 * `Noise_IK_25519_ChaChaPoly_SHA256` (the host recognises its static key).
 * Only these two patterns are implemented, from the Noise specification
 * (revision 34) and checked against the cacophony test vectors.
 *
 * The primitives are the audited @noble libraries, so this file runs
 * unchanged in Node and in a browser (the reference relay serves it to its
 * test page). It imports nothing from Node.
 *
 * After the handshake each direction is a CipherState used with explicit
 * nonces: the frame's sequence number is the nonce (§5.4), so a frame that
 * is sent again after a reconnect decrypts the same way.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { randomBytes } from "@noble/hashes/utils.js";

export const PAIR_PROTOCOL = "Noise_NKpsk0_25519_ChaChaPoly_SHA256";
export const RESUME_PROTOCOL = "Noise_IK_25519_ChaChaPoly_SHA256";

const DHLEN = 32;
const TAGLEN = 16;
const EMPTY = new Uint8Array(0);

/** Message patterns, initiator first; `pre` is the responder's pre-message. */
const PATTERNS = {
  [PAIR_PROTOCOL]: { pre: ["s"], messages: [["psk", "e", "es"], ["e", "ee"]], psk: true },
  [RESUME_PROTOCOL]: { pre: ["s"], messages: [["e", "es", "s", "ss"], ["e", "ee", "se"]], psk: false },
};

const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** ChaChaPoly's 96-bit nonce: 32 zero bits, then the counter little-endian. */
function nonceBytes(n) {
  const nonce = new Uint8Array(12);
  let value = BigInt(n);
  for (let i = 4; i < 12; i++) {
    nonce[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

function hkdf(chainingKey, ikm, outputs) {
  const tempKey = hmac(sha256, chainingKey, ikm);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const out2 = hmac(sha256, tempKey, concat(out1, Uint8Array.of(2)));
  if (outputs === 2) return [out1, out2];
  return [out1, out2, hmac(sha256, tempKey, concat(out2, Uint8Array.of(3)))];
}

/** A key pair: `{ privateKey, publicKey }`, 32 bytes each. */
export function generateKeyPair(privateKey = randomBytes(32)) {
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/**
 * One direction's cipher after the handshake. `nonce` is explicit: the
 * caller's sequence number.
 */
export function cipherState(key) {
  return {
    encrypt: (nonce, plaintext, ad = EMPTY) => chacha20poly1305(key, nonceBytes(nonce), ad).encrypt(plaintext),
    decrypt: (nonce, ciphertext, ad = EMPTY) => chacha20poly1305(key, nonceBytes(nonce), ad).decrypt(ciphertext),
  };
}

/**
 * A handshake state for `protocol` (PAIR_PROTOCOL or RESUME_PROTOCOL).
 *
 *   initiator  true for the browser
 *   prologue   bytes both sides bind in (§5.1: the room)
 *   s          own static key pair (host; browser for IK)
 *   rs         remote static public key (browser: the host's, from the link)
 *   psk        the 32-byte pairing secret (NKpsk0)
 *   e          own ephemeral key pair; generated unless given (test vectors)
 *
 * `writeMessage(payload)` and `readMessage(bytes)` alternate as the pattern
 * says; once both messages are through, `split()` gives `{ send, receive }`
 * cipher states for this side, and `remoteStatic` is the peer's static key
 * when the pattern carried one.
 */
export function createHandshake({ protocol, initiator, prologue = EMPTY, s = null, rs = null, psk = null, e = null }) {
  const pattern = PATTERNS[protocol];
  if (!pattern) throw new Error(`unsupported Noise protocol: ${protocol}`);
  if (pattern.psk && psk?.length !== 32) throw new Error("this handshake needs a 32-byte pre-shared key");

  // SymmetricState.
  const name = utf8(protocol);
  let h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
  let ck = h;
  let k = null;
  let n = 0;
  const mixHash = (data) => {
    h = sha256(concat(h, data));
  };
  const mixKey = (ikm) => {
    [ck, k] = hkdf(ck, ikm, 2);
    n = 0;
  };
  const mixKeyAndHash = (ikm) => {
    const [nextCk, tempH, tempK] = hkdf(ck, ikm, 3);
    ck = nextCk;
    mixHash(tempH);
    k = tempK;
    n = 0;
  };
  const encryptAndHash = (plaintext) => {
    const ciphertext = k ? chacha20poly1305(k, nonceBytes(n++), h).encrypt(plaintext) : plaintext;
    mixHash(ciphertext);
    return ciphertext;
  };
  const decryptAndHash = (ciphertext) => {
    const plaintext = k ? chacha20poly1305(k, nonceBytes(n++), h).decrypt(ciphertext) : ciphertext;
    mixHash(ciphertext);
    return plaintext;
  };
  const dh = (pair, pub) => x25519.getSharedSecret(pair.privateKey, pub);

  mixHash(prologue);
  // Both patterns pre-share the responder's static key.
  if (initiator) {
    if (rs?.length !== DHLEN) throw new Error("the initiator needs the responder's static key");
    mixHash(rs);
  } else {
    if (!s) throw new Error("the responder needs its static key pair");
    mixHash(s.publicKey);
  }

  let localE = e;
  let re = null;
  let remoteStatic = initiator ? rs : null;
  let step = 0;

  const writeTokens = (tokens) => {
    const out = [];
    for (const token of tokens) {
      if (token === "e") {
        localE ??= generateKeyPair();
        out.push(localE.publicKey);
        mixHash(localE.publicKey);
        if (pattern.psk) mixKey(localE.publicKey);
      } else if (token === "s") {
        out.push(encryptAndHash(s.publicKey));
      } else if (token === "psk") {
        mixKeyAndHash(psk);
      } else {
        mixKey(dhToken(token));
      }
    }
    return out;
  };

  const readTokens = (tokens, message) => {
    let at = 0;
    const take = (length) => {
      if (at + length > message.length) throw new Error("handshake message too short");
      const part = message.subarray(at, at + length);
      at += length;
      return part;
    };
    for (const token of tokens) {
      if (token === "e") {
        re = take(DHLEN);
        mixHash(re);
        if (pattern.psk) mixKey(re);
      } else if (token === "s") {
        remoteStatic = decryptAndHash(take(k ? DHLEN + TAGLEN : DHLEN));
      } else if (token === "psk") {
        mixKeyAndHash(psk);
      } else {
        mixKey(dhToken(token));
      }
    }
    return message.subarray(at);
  };

  // DH tokens name (initiator key, responder key).
  const dhToken = (token) => {
    const [mine, theirs] = initiator ? [token[0], token[1]] : [token[1], token[0]];
    const own = mine === "e" ? localE : s;
    const remote = theirs === "e" ? re : remoteStatic;
    if (!own || !remote) throw new Error(`handshake is missing a key for ${token}`);
    return dh(own, remote);
  };

  const myTurn = () => (step % 2 === 0) === initiator;

  return {
    protocol,
    writeMessage(payload = EMPTY) {
      if (step >= pattern.messages.length || !myTurn()) throw new Error("not this side's handshake message");
      const parts = writeTokens(pattern.messages[step]);
      parts.push(encryptAndHash(payload));
      step += 1;
      return concat(...parts);
    },
    readMessage(message) {
      if (step >= pattern.messages.length || myTurn()) throw new Error("not the peer's handshake message");
      const rest = readTokens(pattern.messages[step], message);
      const payload = decryptAndHash(rest);
      step += 1;
      return payload;
    },
    get complete() {
      return step >= pattern.messages.length;
    },
    get remoteStatic() {
      return remoteStatic;
    },
    get handshakeHash() {
      return h;
    },
    split() {
      if (step < pattern.messages.length) throw new Error("the handshake is not complete");
      const [k1, k2] = hkdf(ck, EMPTY, 2);
      const [send, receive] = initiator ? [k1, k2] : [k2, k1];
      return { send: cipherState(send), receive: cipherState(receive) };
    },
  };
}

/** Unpadded base64url (§4.2). */
export function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  const binary = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export { randomBytes };

/** The prologue both sides bind into a handshake (§5.1). */
export const prologueFor = (roomId) => utf8(`unieai-remote-control/1\n${roomId}`);
