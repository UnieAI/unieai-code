// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { adoptLegacyEnv, legacyServerPids, legacySessionPresent, migrateLegacyHome, zstdFrames } from "./rabi-legacy.mjs";

test("old variables fill unset new ones and never override", () => {
  const env = adoptLegacyEnv({ UNIEAI_DSH_PLUGINS: "off", DSH_HOME: "/old", RABI_HOME: "/new" });
  assert.equal(env.UNIEAI_RABI_PLUGINS, "off");
  assert.equal(env.RABI_HOME, "/new");
});

test("the old home moves, rebuilt state is dropped, and session package names follow", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  const old = join(uac, "dsh-home");
  const session = join(old, "sessions", "--work--", "s1");
  mkdirSync(session, { recursive: true });
  mkdirSync(join(old, "profiles", "acp"), { recursive: true });
  mkdirSync(join(old, "attachments"), { recursive: true });
  writeFileSync(join(old, "attachments", "a.png"), "png");
  const line = `{"plugin":"@deepseek-ai/dsh-system-prompt","text":"see /home/me/dsh/AGENTS.md"}\n`;
  const zstd = typeof zlib.zstdCompressSync === "function";
  const logName = zstd ? "session.v4.jsonl.zstd" : "session.v4.jsonl";
  // Rabi appends one frame per write: the header, then each event batch.
  const header = `{"type":"header","version":3}\n`;
  writeFileSync(join(session, logName), zstd ? Buffer.concat([zlib.zstdCompressSync(Buffer.from(header)), zlib.zstdCompressSync(Buffer.from(line))]) : header + line);

  const result = migrateLegacyHome(uac);
  const home = join(uac, "rabi-home");
  assert.equal(result.rewritten, 1);
  assert.ok(!existsSync(old));
  assert.ok(!existsSync(join(home, "profiles")));
  assert.equal(readFileSync(join(home, "attachments", "a.png"), "utf8"), "png");
  const raw = readFileSync(join(home, "sessions", "--work--", "s1", logName));
  const text = zstd ? zstdFrames(raw).map((f) => zlib.zstdDecompressSync(f).toString()).join("") : raw.toString();
  assert.equal(text, `${header}{"plugin":"@unieai/rabi-system-prompt","text":"see /home/me/dsh/AGENTS.md"}\n`);
  if (zstd) assert.equal(zstdFrames(raw).length, 2, "frames are kept");
  assert.equal(migrateLegacyHome(uac), null, "runs once");
});

/** A stand-in for an old uac server: a live process whose argv names it. */
function fakeOldServer(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "unieai-uac-server.mjs"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid;
}

function oldHome(uac, { pid = 999_999_999, sessionIds = ["s-old"] } = {}) {
  const legacy = join(uac, "dsh-home");
  for (const id of sessionIds) {
    mkdirSync(join(legacy, "sessions", "--work--", id), { recursive: true });
    writeFileSync(join(legacy, "sessions", "--work--", id, "session.v4.jsonl"), `{"plugin":"@deepseek-ai/dsh-system-prompt"}\n`);
  }
  mkdirSync(join(legacy, "attachments"), { recursive: true });
  writeFileSync(join(legacy, "attachments", "old.png"), "old");
  writeFileSync(join(legacy, "settings.yaml"), "old: settings\n");
  writeFileSync(join(legacy, "uac.patch.yml"), `- id: unieai-control\n  config:\n    socket: "${uac}/app-server.${pid}.dsh.sock"\n`);
  return legacy;
}

test("the move waits while an old server still runs on the old home", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  const pid = fakeOldServer(t);
  oldHome(uac, { pid });
  assert.deepEqual(legacyServerPids(uac), [pid]);
  assert.deepEqual(migrateLegacyHome(uac), { deferred: true, pids: [pid] });
  assert.ok(existsSync(join(uac, "dsh-home", "sessions")), "nothing moved");
  assert.equal(legacySessionPresent(uac, "s-old"), true);
  assert.equal(legacySessionPresent(uac, "s-other"), false);
});

test("an old server is also seen by its socket file beside the app socket", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  const sockets = mkdtempSync(join(tmpdir(), "rabi-sock-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  t.after(() => rmSync(sockets, { recursive: true, force: true }));
  const pid = fakeOldServer(t);
  oldHome(uac);
  writeFileSync(join(sockets, `app.${pid}.ptc.dsh.sock`), "");
  assert.deepEqual(legacyServerPids(uac), [], "the patch names a dead pid");
  assert.deepEqual(legacyServerPids(uac, { socketDirs: [sockets] }), [pid]);
});

test("a dead old server or an unrelated live pid does not hold the move", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill());
  oldHome(uac, { pid: unrelated.pid });
  if (process.platform === "linux") assert.deepEqual(legacyServerPids(uac), [], "a recycled pid is not an old server");
  else unrelated.kill();
});

test("after a wait, the old home merges into the one used meanwhile", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  oldHome(uac, { sessionIds: ["s-old", "s-both"] });
  // What the new release wrote while it waited.
  const home = join(uac, "rabi-home");
  mkdirSync(join(home, "sessions", "--work--", "s-new"), { recursive: true });
  mkdirSync(join(home, "sessions", "--work--", "s-both"), { recursive: true });
  writeFileSync(join(home, "sessions", "--work--", "s-both", "session.v4.jsonl"), "new\n");
  writeFileSync(join(home, "settings.yaml"), "new: settings\n");

  const result = migrateLegacyHome(uac);
  assert.equal(result.merged, true);
  assert.ok(!existsSync(join(uac, "dsh-home")));
  const sessions = readdirSync(join(home, "sessions", "--work--")).sort();
  assert.deepEqual(sessions, ["s-both", "s-new", "s-old"]);
  assert.equal(readFileSync(join(home, "sessions", "--work--", "s-old", "session.v4.jsonl"), "utf8"), `{"plugin":"@unieai/rabi-system-prompt"}\n`);
  assert.equal(readFileSync(join(home, "sessions", "--work--", "s-both", "session.v4.jsonl"), "utf8"), "new\n", "the new home wins");
  assert.equal(readFileSync(join(home, "settings.yaml"), "utf8"), "new: settings\n");
  assert.equal(readFileSync(join(home, "attachments", "old.png"), "utf8"), "old");
  const [unmerged] = readdirSync(uac).filter((name) => name.startsWith("dsh-home.unmerged-"));
  assert.ok(unmerged, "the clashing old copy is kept aside");
  assert.ok(existsSync(join(uac, unmerged, "sessions", "--work--", "s-both", "session.v4.jsonl")));
  assert.deepEqual(result.left, [join(uac, unmerged, "sessions", "--work--", "s-both", "session.v4.jsonl")]);
  assert.equal(migrateLegacyHome(uac), null, "nothing left to do");
});
