import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point UNIEAI_HOME at a temp dir before importing session (dir resolved per-call).
process.env.UNIEAI_HOME = mkdtempSync(join(tmpdir(), "agent-runtime-test-"));
const { newSessionId, saveSession, loadSession, listSessions } = await import("./session.mjs");

test("session round-trips and lists newest-first with a preview", () => {
  const id = newSessionId();
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "build me a thing" },
    { role: "assistant", content: "done" }
  ];
  saveSession({ id, messages, model: "Qwen3.6", cwd: "/ws" });
  const loaded = loadSession(id);
  assert.equal(loaded.id, id);
  assert.deepEqual(loaded.messages, messages);

  const rows = listSessions();
  const row = rows.find((r) => r.id === id);
  assert.ok(row, "listed");
  assert.equal(row.preview, "build me a thing");
  assert.equal(row.model, "Qwen3.6");
});

test("newSessionId is unique and filesystem-safe", () => {
  const a = newSessionId(), b = newSessionId();
  assert.notEqual(a, b);
  assert.match(a, /^[\w-]+$/);
});
