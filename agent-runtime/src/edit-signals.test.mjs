// Both checks here were reverse-engineered from real SWE-bench failures where the
// agent edited the correct file and still produced a wrong fix, so the tests use
// those exact shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introducedSymbols, unprecedentedSymbolNote, inconsistentReturnNote } from "./edit-signals.mjs";

function ws(files) {
  const dir = mkdtempSync(join(tmpdir(), "edit-signals-"));
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
const with_ = (files, fn) => { const d = ws(files); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test("introducedSymbols reports attribute calls the edit added", () => {
  const got = introducedSymbols("x = np.zeros(3)", "x = np.zeros(3)\ny = np.hstack([x])");
  assert.deepEqual(got, ["np.hstack"]);
});

test("introducedSymbols sees dotted names hidden in strings", () => {
  // The real miss: the API was named inside _module_format('mpmath.fraction').
  const got = introducedSymbols("self._module_format('mpmath.mpf')", "self._module_format('mpmath.fraction')");
  assert.ok(got.includes("mpmath.fraction"));
});

test("introducedSymbols ignores what was already there", () => {
  assert.deepEqual(introducedSymbols("a.b()\nc.d()", "c.d()\na.b()"), []);
});

test("an API the project never uses is flagged, naming how often the namespace IS used", () => {
  with_({
    "printing/pycode.py": "def f(self, e):\n    return self._module_format('mpmath.mpf')\n",
    "core/evalf.py": "from mpmath import mp\nx = mpmath.mpf(1)\ny = mpmath.mpf(2)\n",
  }, (d) => {
    const note = unprecedentedSymbolNote(d, "self._module_format('mpmath.mpf')", "self._module_format('mpmath.fraction')");
    assert.match(note, /mpmath\.fraction` appears nowhere else/);
    assert.match(note, /mpmath\.` is used/);
  });
});

test("an established API is not flagged", () => {
  with_({ "a.py": "x = mpmath.mpf(1)\n", "b.py": "y = mpmath.mpf(2)\n" }, (d) => {
    assert.equal(unprecedentedSymbolNote(d, "pass", "x = mpmath.mpf(3)"), "");
  });
});

test("an entirely new namespace is left alone (that is just a new import)", () => {
  with_({ "a.py": "x = 1\n" }, (d) => {
    assert.equal(unprecedentedSymbolNote(d, "pass", "y = brandnew.thing()"), "");
  });
});

test("a function that gained a value-return while keeping a bare return is flagged", () => {
  // django bulk_update: the early `if not objs: return` was left returning None.
  const body = [
    "class QuerySet:",
    "    def bulk_update(self, objs, fields):",
    "        if not objs:",
    "            return",
    "        rows_updated = 0",
    "        for pks in batches:",
    "            rows_updated += self.filter(pk__in=pks).update()",
    "        return rows_updated",
  ].join("\n");
  const note = inconsistentReturnNote("django/db/models/query.py", body, "        return rows_updated");
  assert.match(note, /bulk_update` now returns a value/);
  assert.match(note, /line 4 still has a bare `return`/);
});

test("a function whose paths all return a value is not flagged", () => {
  const body = "def f(x):\n    if not x:\n        return 0\n    return len(x)\n";
  assert.equal(inconsistentReturnNote("a.py", body, "    return len(x)"), "");
});

test("an edit that added no value-return is not flagged", () => {
  const body = "def f(x):\n    if not x:\n        return\n    print(x)\n";
  assert.equal(inconsistentReturnNote("a.py", body, "    print(x)"), "");
});

test("non-Python files are skipped", () => {
  assert.equal(inconsistentReturnNote("a.ts", "function f(){ return 1 }", "return 1"), "");
});

test("a bare return in a DIFFERENT function does not trigger the note", () => {
  const body = [
    "def other(x):",
    "    return",
    "",
    "def target(y):",
    "    return len(y)",
  ].join("\n");
  assert.equal(inconsistentReturnNote("a.py", body, "    return len(y)"), "");
});
