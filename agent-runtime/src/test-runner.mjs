/**
 * test-runner.mjs — work out how a project runs its own tests, and build the
 * command to run a targeted slice of them.
 *
 * "Verify with the project's own checks" has been in the system prompt for a
 * while and does not reliably happen: the model has to guess the invocation, the
 * guess is wrong in repos with a custom runner (Django's `tests/runtests.py`,
 * Sphinx's tox setup), the guess fails, and after a couple of failures it gives
 * up and calls the patch done. Detection is a property of the repository, not a
 * judgement call — so it belongs in a tool, where it is decided once, correctly,
 * and the model only has to say WHICH tests to run.
 *
 * Everything here is pure except `detectRunner`, which only reads the workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (dir, name) => {
  try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; }
};

/**
 * Identify the project's test runner.
 * Returns { kind, cwd, why } — `kind` drives buildTestCommand, `why` is shown to
 * the model so a wrong detection is debuggable rather than mysterious.
 */
export function detectRunner(workspace) {
  // Django and friends ship a bespoke runner that pytest cannot drive correctly:
  // it builds settings and a test database first. Check it before pytest markers,
  // because these repos ALSO carry a setup.cfg that mentions pytest.
  if (existsSync(join(workspace, "tests", "runtests.py"))) {
    return { kind: "django-runtests", cwd: "tests", why: "tests/runtests.py" };
  }
  const pyproject = read(workspace, "pyproject.toml");
  const setupCfg = read(workspace, "setup.cfg");
  const toxIni = read(workspace, "tox.ini");
  const pytestMarker =
    existsSync(join(workspace, "pytest.ini")) ||
    existsSync(join(workspace, "conftest.py")) ||
    /\[tool\.pytest/.test(pyproject) ||
    /\[tool:pytest\]/.test(setupCfg) ||
    /\bpytest\b/.test(toxIni);
  if (pytestMarker) return { kind: "pytest", cwd: ".", why: "pytest configuration" };

  const pkgRaw = read(workspace, "package.json");
  if (pkgRaw) {
    let pkg = {};
    try { pkg = JSON.parse(pkgRaw); } catch { /* malformed package.json — fall through */ }
    const script = pkg?.scripts?.test;
    const dev = { ...(pkg?.devDependencies || {}), ...(pkg?.dependencies || {}) };
    if (dev.vitest) return { kind: "vitest", cwd: ".", why: "vitest dependency" };
    if (dev.jest) return { kind: "jest", cwd: ".", why: "jest dependency" };
    if (script) return { kind: "npm-test", cwd: ".", why: "package.json scripts.test" };
    return { kind: "node-test", cwd: ".", why: "package.json without a test script" };
  }
  if (existsSync(join(workspace, "Cargo.toml"))) return { kind: "cargo", cwd: ".", why: "Cargo.toml" };
  if (existsSync(join(workspace, "go.mod"))) return { kind: "go", cwd: ".", why: "go.mod" };
  // A Python project with no pytest marker still runs unittest.
  if (pyproject || setupCfg || existsSync(join(workspace, "setup.py"))) {
    return { kind: "unittest", cwd: ".", why: "Python project without pytest configuration" };
  }
  return { kind: null, cwd: ".", why: "no recognised test configuration" };
}

/**
 * Build the shell command for `runner` restricted to `target`.
 *
 * `target` is whatever selects tests for that runner — a path, a dotted module,
 * a `file::test` node id. Empty target means the whole suite, which is usually a
 * mistake on a large repo, so callers should encourage a narrow one.
 */
export function buildTestCommand(runner, target = "", { keyword = "" } = {}) {
  const t = String(target || "").trim();
  const k = String(keyword || "").trim();
  switch (runner?.kind) {
    case "django-runtests":
      // runtests.py takes dotted test labels relative to the tests/ directory and
      // must run from inside it. Strip a leading tests/ so both spellings work.
      return `python3 runtests.py --parallel=1 --verbosity=2 ${t.replace(/^tests\//, "").replace(/\//g, ".").replace(/\.py$/, "") || ""}`.trim();
    case "pytest":
      return `python3 -m pytest -x -q --no-header ${t}${k ? ` -k ${JSON.stringify(k)}` : ""}`.trim();
    case "unittest":
      return `python3 -m unittest ${t || "discover"} -v`.trim();
    case "vitest":
      return `npx vitest run ${t}${k ? ` -t ${JSON.stringify(k)}` : ""}`.trim();
    case "jest":
      return `npx jest ${t}${k ? ` -t ${JSON.stringify(k)}` : ""}`.trim();
    case "npm-test":
      return `npm test --silent ${t ? `-- ${t}` : ""}`.trim();
    case "node-test":
      return `node --test ${t}`.trim();
    case "cargo":
      return `cargo test ${t}`.trim();
    case "go":
      return `go test ${t || "./..."}`.trim();
    default:
      return "";
  }
}

// Lines worth keeping from a long test log: the verdict, the failures, and the
// errors. Everything else is per-test chatter that costs context and says nothing.
const SIGNAL_RE =
  /(^(FAILED|ERROR|FAIL|ok|PASSED)\b|^(=+\s*(FAILURES|ERRORS|short test summary|test session starts))|^\s*(assert|E\s{2,})|^Ran \d+ tests?|^(OK|FAILED)\s*\(|passed|failed|error|Traceback|^\s+File ")/;

/**
 * Reduce a test log to what a model needs to act on: the tail (where the verdict
 * lives) plus any failure/assert lines from earlier. Keeps the log honest —
 * nothing is rewritten, only dropped.
 */
export function summarizeTestOutput(output, { maxLines = 80 } = {}) {
  const lines = String(output || "").split("\n");
  if (lines.length <= maxLines) return String(output || "");
  const signal = [];
  for (const l of lines) if (SIGNAL_RE.test(l)) signal.push(l);
  const tail = lines.slice(-30);
  const seen = new Set();
  const kept = [];
  for (const l of [...signal.slice(0, maxLines - 30), ...tail]) {
    if (seen.has(l)) continue;
    seen.add(l);
    kept.push(l);
  }
  return `[test output reduced to failures + verdict; ${lines.length} lines total]\n${kept.join("\n")}`;
}

/**
 * Best guess at the tests covering `relPath`, by the naming conventions every
 * ecosystem shares (`test_<name>`, `<name>_test`, `<name>.test.*`) in the usual
 * places. Returns "" when nothing convincing exists — a wrong target sends the
 * model chasing an unrelated failure, which is worse than no suggestion.
 */
export function guessTestTarget(workspace, relPath) {
  const p = String(relPath || "");
  const base = p.split("/").pop() || "";
  const stem = base.replace(/\.[^.]+$/, "");
  const ext = (base.match(/\.[^.]+$/) || [""])[0];
  if (!stem) return "";
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const parents = new Set(["tests", "test", dir ? `${dir}/tests` : "", dir ? `${dir}/test` : "", dir].filter(Boolean));
  const names = [`test_${stem}${ext}`, `${stem}_test${ext}`, `test_${stem}.py`, `${stem}.test.js`, `${stem}.test.ts`];
  for (const parent of parents) {
    for (const n of names) {
      const cand = `${parent}/${n}`.replace(/^\.\//, "");
      if (existsSync(join(workspace, cand))) return cand;
    }
  }
  return "";
}

/** Did this run pass? Conservative: anything ambiguous is reported as unknown. */
export function verdictFrom(exitCode, output) {
  const s = String(output || "");
  // A green exit code is not proof on its own: wrappers (`npm test || true`, CI
  // shims, some custom runners) exit 0 while the summary reports failures. Trust
  // the reported summary over the exit status when they disagree.
  const tailSaysFailed = /\b(FAILED|ERROR)\b/.test(s.split("\n").slice(-15).join("\n"));
  if (/no tests ran|collected 0 items|Ran 0 tests/i.test(s)) return "no-tests-selected";
  return exitCode === 0 && !tailSaysFailed ? "passed" : "failed";
}
