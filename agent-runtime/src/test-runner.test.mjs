import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRunner, buildTestCommand, summarizeTestOutput, verdictFrom, guessTestTarget } from "./test-runner.mjs";

function ws(files) {
  const dir = mkdtempSync(join(tmpdir(), "test-runner-"));
  for (const [p, body] of Object.entries(files)) {
    const abs = join(dir, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
const with_ = (files, fn) => { const d = ws(files); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test("a custom runner wins over pytest markers", () => {
  // Django ships tests/runtests.py AND a setup.cfg mentioning pytest; driving it
  // with pytest does not build the test database and every test errors.
  with_({ "tests/runtests.py": "#!/usr/bin/env python", "setup.cfg": "[tool:pytest]\n" }, (d) => {
    const r = detectRunner(d);
    assert.equal(r.kind, "django-runtests");
    assert.equal(r.cwd, "tests");
  });
});

test("pytest is detected from any of its configuration homes", () => {
  with_({ "pytest.ini": "" }, (d) => assert.equal(detectRunner(d).kind, "pytest"));
  with_({ "pyproject.toml": "[tool.pytest.ini_options]\n" }, (d) => assert.equal(detectRunner(d).kind, "pytest"));
  with_({ "setup.cfg": "[tool:pytest]\n" }, (d) => assert.equal(detectRunner(d).kind, "pytest"));
  with_({ "conftest.py": "" }, (d) => assert.equal(detectRunner(d).kind, "pytest"));
});

test("javascript projects resolve to their actual runner", () => {
  with_({ "package.json": JSON.stringify({ devDependencies: { vitest: "^1" }, scripts: { test: "vitest" } }) },
    (d) => assert.equal(detectRunner(d).kind, "vitest"));
  with_({ "package.json": JSON.stringify({ devDependencies: { jest: "^29" } }) },
    (d) => assert.equal(detectRunner(d).kind, "jest"));
  with_({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) },
    (d) => assert.equal(detectRunner(d).kind, "npm-test"));
});

test("a malformed package.json does not throw", () => {
  with_({ "package.json": "{not json" }, (d) => assert.equal(detectRunner(d).kind, "node-test"));
});

test("other ecosystems and the no-runner case", () => {
  with_({ "Cargo.toml": "[package]\n" }, (d) => assert.equal(detectRunner(d).kind, "cargo"));
  with_({ "go.mod": "module x\n" }, (d) => assert.equal(detectRunner(d).kind, "go"));
  with_({ "setup.py": "" }, (d) => assert.equal(detectRunner(d).kind, "unittest"));
  with_({ "README.md": "" }, (d) => assert.equal(detectRunner(d).kind, null));
});

test("django labels are dotted and relative to the tests directory", () => {
  const r = { kind: "django-runtests", cwd: "tests" };
  assert.match(buildTestCommand(r, "tests/migrations/test_autodetector.py"), /runtests\.py .*migrations\.test_autodetector$/);
  assert.match(buildTestCommand(r, "migrations"), /runtests\.py .*migrations$/);
});

test("pytest passes target and keyword through safely", () => {
  const r = { kind: "pytest", cwd: "." };
  assert.equal(buildTestCommand(r, "tests/test_x.py::test_y"), "python3 -m pytest -x -q --no-header tests/test_x.py::test_y");
  // A keyword with spaces/quotes must not break out of the command.
  assert.match(buildTestCommand(r, "tests/", { keyword: 'a or "b"' }), /-k "a or \\"b\\""$/);
});

test("an unknown runner yields no command rather than a wrong one", () => {
  assert.equal(buildTestCommand({ kind: null }, "x"), "");
});

test("summarizeTestOutput keeps failures and the verdict, drops the chatter", () => {
  const noise = Array.from({ length: 300 }, (_, i) => `test_${i} ... ok`).join("\n");
  const log = `${noise}\nFAILED tests/test_a.py::test_boom - AssertionError\nRan 301 tests\nFAILED (failures=1)`;
  const out = summarizeTestOutput(log);
  assert.match(out, /FAILED tests\/test_a\.py::test_boom/);
  assert.match(out, /FAILED \(failures=1\)/);
  assert.ok(out.length < log.length / 2);
  assert.match(out, /reduced to failures \+ verdict; 303 lines total/);
});

test("short output is passed through untouched", () => {
  assert.equal(summarizeTestOutput("ok\n2 passed"), "ok\n2 passed");
});

test("verdictFrom distinguishes pass, fail, and nothing-selected", () => {
  assert.equal(verdictFrom(0, "5 passed in 0.2s"), "passed");
  assert.equal(verdictFrom(1, "FAILED tests/test_a.py"), "failed");
  assert.equal(verdictFrom(5, "collected 0 items"), "no-tests-selected");
  // exit 0 but the tail still shouts FAILED — do not call that a pass.
  assert.equal(verdictFrom(0, "FAILED (failures=1)"), "failed");
});

test("guessTestTarget finds conventional test files, and stays quiet otherwise", () => {
  with_({ "src/parser.py": "", "tests/test_parser.py": "" },
    (d) => assert.equal(guessTestTarget(d, "src/parser.py"), "tests/test_parser.py"));
  with_({ "pkg/thing.py": "", "pkg/tests/test_thing.py": "" },
    (d) => assert.equal(guessTestTarget(d, "pkg/thing.py"), "pkg/tests/test_thing.py"));
  with_({ "src/util.ts": "", "src/util.test.ts": "" },
    (d) => assert.equal(guessTestTarget(d, "src/util.ts"), "src/util.test.ts"));
  // Nothing convincing → no suggestion, rather than a target that sends the
  // model chasing an unrelated failure.
  with_({ "src/lonely.py": "" }, (d) => assert.equal(guessTestTarget(d, "src/lonely.py"), ""));
  with_({}, (d) => assert.equal(guessTestTarget(d, ""), ""));
});
