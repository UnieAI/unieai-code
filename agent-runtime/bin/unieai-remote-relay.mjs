#!/usr/bin/env node
// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-remote-relay.mjs — run the reference Remote Control relay and its
 * test page (agent-runtime/src/remote-relay). For end-to-end testing and as
 * an on-prem fallback; Ava hosts the production relay.
 *
 *   REMOTE_RELAY_ALLOWED_ORIGINS=https://agent.unieai.com node agent-runtime/bin/unieai-remote-relay.mjs
 *   UNIEAI_REMOTE_RELAY_URL=http://<host>:8790/api/remote unieai remote-control start
 *
 * Environment:
 *   PORT                          listen port (default 8790)
 *   HOST                          listen address (default 127.0.0.1)
 *   REMOTE_RELAY_PUBLIC_URL       the origin browsers reach it at (default http://HOST:PORT);
 *                                 put it behind TLS for anything but a local test
 *   REMOTE_RELAY_ALLOWED_ORIGINS  comma-separated Rabi/Studio origins whose sign-ins
 *                                 may register hosts (validated against their own API)
 *   REMOTE_RELAY_STUB_AUTH=1      accept any host token (local testing only)
 */
import { startRemoteRelay, stubValidator, upstreamValidator } from "../src/remote-relay/unieai-remote-relay.mjs";

const allowedOrigins = (process.env.REMOTE_RELAY_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const stub = process.env.REMOTE_RELAY_STUB_AUTH === "1";
if (!stub && allowedOrigins.length === 0) {
  process.stderr.write("Set REMOTE_RELAY_ALLOWED_ORIGINS (e.g. https://agent.unieai.com), or REMOTE_RELAY_STUB_AUTH=1 for a local test.\n");
  process.exit(2);
}

const relay = await startRemoteRelay({
  port: Number(process.env.PORT) || 8790,
  host: process.env.HOST || "127.0.0.1",
  publicUrl: process.env.REMOTE_RELAY_PUBLIC_URL?.replace(/\/+$/, "") || null,
  validateHost: stub ? stubValidator : upstreamValidator({ allowedOrigins }),
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stderr.write(`UnieAI Remote Control relay on ${relay.url} (API ${relay.relayUrl})${stub ? " — stub host auth, testing only" : ""}\n`);
const stop = () => relay.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
