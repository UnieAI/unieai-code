import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** session.mjs resolves its directory from UNIEAI_HOME at call time. */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "unieai-session-"));
  const prev = process.env.UNIEAI_HOME;
  process.env.UNIEAI_HOME = home;
  try {
    const mod = await import(`./session.mjs?home=${encodeURIComponent(home)}`);
    return await fn(mod, home);
  } finally {
    if (prev === undefined) delete process.env.UNIEAI_HOME;
    else process.env.UNIEAI_HOME = prev;
  }
}

test("a session round-trips", async () => {
  await withHome(async ({ saveSession, loadSession }) => {
    saveSession({ id: "s1", messages: [{ role: "user", content: "hi" }], model: "m", cwd: "/w" });
    assert.deepEqual(loadSession("s1").messages, [{ role: "user", content: "hi" }]);
  });
});

test("a traversing id cannot write outside the sessions directory", async () => {
  await withHome(async ({ saveSession }, home) => {
    const path = saveSession({ id: "../../escaped", messages: [], model: "m", cwd: "/w" });
    assert.ok(path.startsWith(join(home, "agent-sessions")), `escaped to ${path}`);
    assert.ok(!existsSync(join(home, "escaped.json")), "a file landed outside the directory");
  });
});

test("save and load agree on how an id is sanitized", async () => {
  await withHome(async ({ saveSession, loadSession }) => {
    // Previously load sanitized and save did not, so a written session could
    // not be read back under the same id.
    saveSession({ id: "weird/../id", messages: [{ role: "user", content: "x" }], model: "m", cwd: "/w" });
    assert.equal(loadSession("weird/../id").messages[0].content, "x");
  });
});

test("a failed write leaves the previous session intact", async () => {
  await withHome(async ({ saveSession, loadSession }, home) => {
    saveSession({ id: "s1", messages: [{ role: "user", content: "original" }], model: "m", cwd: "/w" });

    // Content that cannot be serialized fails mid-save.
    const circular = {};
    circular.self = circular;
    assert.throws(() => saveSession({ id: "s1", messages: [circular], model: "m", cwd: "/w" }));

    assert.equal(loadSession("s1").messages[0].content, "original", "the live file was damaged by a failed write");
    const leftovers = (await readdir(join(home, "agent-sessions"))).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "a temp file was left behind");
  });
});

test("the temp file shares the directory, so the rename stays atomic", async () => {
  await withHome(async ({ saveSession }, home) => {
    const dir = join(home, "agent-sessions");
    saveSession({ id: "s1", messages: [], model: "m", cwd: "/w" });
    // Nothing should remain, but the point is it was never written elsewhere:
    // a temp on another filesystem would make rename a copy-then-delete.
    assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
    assert.ok(existsSync(join(dir, "s1.json")));
  });
});

test("a corrupt session is listed as damaged rather than disappearing", async () => {
  await withHome(async ({ saveSession, listSessions }, home) => {
    saveSession({ id: "good", messages: [{ role: "user", content: "readable" }], model: "m", cwd: "/w" });
    await writeFile(join(home, "agent-sessions", "broken.json"), "{ not json", "utf8");

    const rows = listSessions();
    assert.equal(rows.length, 2, "the damaged session vanished from the list");
    const broken = rows.find((r) => r.id === "broken");
    assert.equal(broken.corrupt, true);
    assert.match(broken.preview, /damaged/);
    // The file itself is untouched, so it can still be recovered by hand.
    assert.equal(await readFile(join(home, "agent-sessions", "broken.json"), "utf8"), "{ not json");
  });
});

test("healthy sessions are not marked corrupt", async () => {
  await withHome(async ({ saveSession, listSessions }) => {
    saveSession({ id: "good", messages: [{ role: "user", content: "hello" }], model: "m", cwd: "/w" });
    const [row] = listSessions();
    assert.equal(row.corrupt, undefined);
    assert.match(row.preview, /hello/);
  });
});
