// ripgrep's default engine rejects lookaround, but the model writes regexes in
// Python/JS dialects where lookaround is ordinary. A pattern like
// `standard_duration_re|(?=\d+:\d+)` came back as "ripgrep exited 2", and the
// model had no way to know which construct was unsupported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodingTools } from "./tools.mjs";

function ws(files) {
  const dir = mkdtempSync(join(tmpdir(), "grep-pcre-"));
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body);
  return dir;
}

test("a lookahead pattern searches successfully instead of erroring", async () => {
  const dir = ws({ "a.py": "duration = '12:30'\nplain = 'nope'\n" });
  try {
    const t = await buildCodingTools({ workspace: dir })();
    const r = await t.executors.grep({ pattern: "duration(?=\\s*=)" });
    assert.equal(r.ok, true, `grep failed: ${r.modelText}`);
    assert.match(r.modelText, /a\.py/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a lookbehind pattern also works", async () => {
  const dir = ws({ "a.py": "x = 1\nself.value = 2\n" });
  try {
    const t = await buildCodingTools({ workspace: dir })();
    const r = await t.executors.grep({ pattern: "(?<=self\\.)value" });
    assert.equal(r.ok, true, `grep failed: ${r.modelText}`);
    assert.match(r.modelText, /a\.py/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ordinary pattern still reports no matches as success", async () => {
  const dir = ws({ "a.py": "nothing here\n" });
  try {
    const t = await buildCodingTools({ workspace: dir })();
    const r = await t.executors.grep({ pattern: "absent_symbol" });
    assert.equal(r.ok, true);
    assert.match(r.modelText, /No matches/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a genuinely broken pattern still reports the parse error", async () => {
  const dir = ws({ "a.py": "x\n" });
  try {
    const t = await buildCodingTools({ workspace: dir })();
    const r = await t.executors.grep({ pattern: "(unclosed" });
    assert.equal(r.ok, false);
    assert.match(r.modelText, /regex parse error|unclosed/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
