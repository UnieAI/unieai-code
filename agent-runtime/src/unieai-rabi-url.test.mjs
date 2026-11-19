// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostCredential, resolveRelayUrl } from "./app-server/unieai-remote-bridge.mjs";
import { RABI_URL, canonicalRabiUrl, loadCredentials } from "./config.mjs";
import { resolveAccount } from "./unieai-dsh/unieai-artifacts-core.mjs";

const OLD = "https://agent.unieai.com";

test("Rabi's former origin becomes the current one; other URLs are left alone", () => {
  assert.equal(canonicalRabiUrl(OLD), RABI_URL);
  assert.equal(canonicalRabiUrl(`${OLD}/api/desktop/v1`), `${RABI_URL}/api/desktop/v1`);
  for (const url of ["https://studio.unieai.com", `${OLD}.example.org/api`, "https://agent.demo.unieai.com", "", undefined]) {
    assert.equal(canonicalRabiUrl(url), url);
  }
});

function oldRabiLogin(t) {
  const home = mkdtempSync(join(tmpdir(), "rabi-url-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(
    join(home, "unieai.json"),
    JSON.stringify({ account: "rabi", studio_url: OLD, access_token: "rk-1", gateway_base_url: `${OLD}/api/desktop/v1`, gateway_api_key: "rk-1", email: "u@example.com" }),
  );
  return home;
}

test("a Rabi login stored before the move reaches the current origin everywhere", (t) => {
  const home = oldRabiLogin(t);
  for (const name of ["UNIEAI_HOME", "CODEX_HOME"]) {
    const saved = process.env[name];
    process.env[name] = home;
    t.after(() => (saved === undefined ? delete process.env[name] : (process.env[name] = saved)));
  }

  const credentials = loadCredentials();
  assert.equal(credentials.gatewayBaseUrl, `${RABI_URL}/api/desktop/v1`);
  assert.equal(credentials.studioUrl, RABI_URL);
  assert.equal(credentials.accountId, `rabi|${OLD}/api/desktop/v1|u@example.com`, "the account id stays what the TUI computes");
  assert.equal(hostCredential(home).origin, RABI_URL);
  assert.equal(resolveAccount(home).baseUrl, RABI_URL, "artifacts publish to the current origin");
  assert.equal(resolveRelayUrl({ env: {}, settings: { relayUrl: `${OLD}/api/remote/` } }), `${RABI_URL}/api/remote`);
  assert.equal(resolveRelayUrl({ env: {}, settings: {} }), `${RABI_URL}/api/remote`);
});
