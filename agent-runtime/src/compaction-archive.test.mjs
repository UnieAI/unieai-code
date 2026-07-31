import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompactionArchive, listArchives, readArchive } from "./compaction-archive.mjs";
import { compactWithSummary } from "../../third_party/unieai-agent-core/src/compaction.mjs";

const FOLDED = [
  { role: "user", content: "switch the tunnel to loopback" },
  { role: "assistant", content: "done, see exec-server/src/ws.rs:88" },
];

async function archiveInto() {
  const dir = await mkdtemp(join(tmpdir(), "unieai-archive-"));
  return { dir, archive: createCompactionArchive({ sessionId: "sess-1", dir }) };
}

test("a fold is written with the originals kept verbatim", async () => {
  const { dir, archive } = await archiveInto();
  const file = await archive({
    requestId: "r1",
    folded: FOLDED,
    summary: "moved the tunnel to loopback",
    prevSummary: "",
    systemCount: 1,
    foldedCount: 2,
    keptCount: 4,
    tokensBefore: 9000,
  });

  const body = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(body.folded, FOLDED, "the originals must survive untruncated");
  assert.equal(body.summary, "moved the tunnel to loopback");
  assert.equal(body.tokensBefore, 9000);
  assert.equal(body.foldedCount, 2);
  assert.equal(body.sessionId, "sess-1");
  assert.match(body.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(file.startsWith(dir));
});

test("repeated folds in one session do not overwrite each other", async () => {
  const { dir, archive } = await archiveInto();
  await archive({ folded: [{ role: "user", content: "first" }], summary: "a" });
  await archive({ folded: [{ role: "user", content: "second" }], summary: "b" });

  const found = listArchives({ dir });
  assert.equal(found.length, 2);
  const summaries = found.map((f) => readArchive(f.path).summary).sort();
  assert.deepEqual(summaries, ["a", "b"]);
});

test("listing returns newest first and reading a missing file is null", async () => {
  const { dir, archive } = await archiveInto();
  await archive({ folded: [], summary: "older" });
  await new Promise((r) => setTimeout(r, 10));
  await archive({ folded: [], summary: "newer" });

  const [first] = listArchives({ dir });
  assert.equal(readArchive(first.path).summary, "newer");
  assert.equal(readArchive(join(dir, "absent.json")), null);
});

test("listing an archive directory that does not exist yields nothing", () => {
  assert.deepEqual(listArchives({ dir: "/nonexistent/unieai-archive" }), []);
});

test("compactWithSummary hands the archive the originals BEFORE replacing them", async () => {
  const { archive } = await archiveInto();
  const seen = [];
  const messages = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `turn ${i} ${"detail ".repeat(200)}`,
    })),
  ];

  const result = await compactWithSummary({
    messages,
    prevSummary: "",
    summarize: async () => "a rolling summary",
    ctx: { requestId: "r", contextTokens: 4000 },
    archive: async (record) => { seen.push(record); return archive(record); },
  });

  assert.equal(result.changed, true, "the fixture must be large enough to fold");
  assert.equal(seen.length, 1);
  assert.ok(seen[0].folded.length > 0);
  assert.equal(seen[0].summary, "a rolling summary");
  // The archived originals must be the messages that disappear from the result.
  const survived = new Set(result.messages.map((m) => m.content));
  assert.ok(seen[0].folded.some((m) => !survived.has(m.content)), "archived nothing that was actually dropped");
});

test("a failing archive is swallowed — losing the archive must not cost the turn", async () => {
  const messages = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `turn ${i} ${"x ".repeat(200)}` })),
  ];
  const result = await compactWithSummary({
    messages,
    prevSummary: "",
    summarize: async () => "summary",
    ctx: { requestId: "r", contextTokens: 4000 },
    archive: async () => { throw new Error("disk full"); },
  });
  assert.equal(result.changed, true, "compaction must still succeed");
  assert.equal(result.summary, "summary");
});

test("no archive hook keeps the previous behaviour exactly", async () => {
  const messages = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `turn ${i} ${"x ".repeat(200)}` })),
  ];
  const result = await compactWithSummary({
    messages,
    prevSummary: "",
    summarize: async () => "summary",
    ctx: { requestId: "r", contextTokens: 4000 },
  });
  assert.equal(result.changed, true);
});
