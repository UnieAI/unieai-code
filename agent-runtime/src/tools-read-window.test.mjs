// A `read` that ignores offset/limit is worse than one that has no windowing at
// all: the model asks for line 4000, gets the head of the file back, asks again,
// gets the same head, and concludes the tool is broken. In the SWE-bench Verified
// runs that is exactly what happened — the model abandoned `read` and shelled out
// to `sed -n` for every subsequent look at a file, which bloated the context and
// tripped the loop's consecutive-bash doom streak into ending turns early.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

function tmpWs() {
  return mkdtempSync(join(tmpdir(), "read-window-"));
}
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("read returns the whole file when no window is given", async () => {
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    writeFileSync(join(dir, "a.txt"), lines(5));
    const r = await t.executors.read({ filePath: "a.txt" });
    assert.equal(r.modelText, lines(5));
    assert.ok(!r.modelText.startsWith("[lines")); // no header when nothing was windowed
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read honours offset and limit as a 1-based line window", async () => {
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    writeFileSync(join(dir, "a.txt"), lines(100));
    const r = await t.executors.read({ filePath: "a.txt", offset: 10, limit: 3 });
    assert.match(r.modelText, /^\[lines 10-12 of 100\]\n/);
    assert.equal(r.modelText.split("\n").slice(1).join("\n"), "line 10\nline 11\nline 12");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read with offset alone runs to the end of the file", async () => {
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    writeFileSync(join(dir, "a.txt"), lines(6));
    const r = await t.executors.read({ filePath: "a.txt", offset: 5 });
    assert.match(r.modelText, /^\[lines 5-6 of 6\]\n/);
    assert.equal(r.modelText.split("\n").slice(1).join("\n"), "line 5\nline 6");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a window past the end of the file is an error, not a silent empty read", async () => {
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    writeFileSync(join(dir, "a.txt"), lines(5));
    const r = await t.executors.read({ filePath: "a.txt", offset: 99, limit: 10 });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /past the end.*5 lines/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a windowed read still lets a later edit through the staleness check", async () => {
  // The window is what the model SAW; the hash recorded is the whole file, so an
  // edit after a windowed read must not be rejected as "you never read this file".
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    writeFileSync(join(dir, "a.txt"), lines(50));
    await t.executors.read({ filePath: "a.txt", offset: 20, limit: 5 });
    const r = await t.executors.edit({ filePath: "a.txt", oldString: "line 22", newString: "LINE 22" });
    assert.equal(r.ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the read schema advertises offset and limit", async () => {
  const dir = tmpWs();
  try {
    const t = await buildCodingTools({ workspace: dir })();
    const read = t.schemas.find((s) => s.function?.name === "read");
    // A model can only use a parameter it can see in the schema.
    assert.ok(read.function.parameters.properties.offset);
    assert.ok(read.function.parameters.properties.limit);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
