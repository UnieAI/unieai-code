// Copyright (c) 2026 UnieAI. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { adoptLegacyEnv, migrateLegacyHome, zstdFrames } from "./rabi-legacy.mjs";

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

test("an existing new home wins and the old one is left alone", (t) => {
  const uac = mkdtempSync(join(tmpdir(), "rabi-legacy-"));
  t.after(() => rmSync(uac, { recursive: true, force: true }));
  mkdirSync(join(uac, "dsh-home"));
  mkdirSync(join(uac, "rabi-home"));
  assert.equal(migrateLegacyHome(uac), null);
  assert.ok(existsSync(join(uac, "dsh-home")));
});
