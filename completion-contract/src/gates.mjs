/**
 * gates.mjs — the deterministic half of the completion contract.
 *
 * Everything here is a fact about the workspace, established without a model
 * call: did anything change, does the changed Python still compile and import,
 * did the turn edit tests it was told not to, did it leave an identical copy of
 * the line it just fixed sitting next to it.
 *
 * Cheap, so these run before the skeptic and can refuse a turn on their own.
 * Extracted from the engine unchanged: this is the part that was measured, and
 * it depends on nothing but `git`, `python3` and the workspace path.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MID = (s, max) => (s.length <= max ? s : `${s.slice(0, max / 2)}\n[...truncated...]\n${s.slice(-max / 2)}`);

// New files, rendered so the skeptic can judge them alongside `git diff` (which
// only ever shows tracked edits). Capped hard: a verification prompt is not the
// place to paste a build output or a vendored directory that happens to be
// untracked, and a file's opening lines are enough to say what it is.
export function untrackedDigest(workspace, porcelain) {
  const paths = String(porcelain || "")
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  if (!paths.length) return "";
  let out = "\n\n## New (untracked) files\n";
  for (const p of paths.slice(0, 5)) {
    let body = "";
    try {
      body = readFileSync(join(workspace, p), "utf8").split("\n").slice(0, 60).join("\n");
    } catch { continue; } // a directory or an unreadable blob — the name still tells the reviewer it exists
    out += `\n### ${p}\n${MID(body, 1500)}\n`;
  }
  if (paths.length > 5) out += `\n(+${paths.length - 5} more untracked paths)\n`;
  return out;
}

// Deterministic pre-gates over the changed files (v0.3.0, from SWE-bench
// failure-mode analysis: most applied-but-failed patches die on errors a single
// execution would have caught). Best-effort: environments without the repo's
// deps must never false-positive, so anything that looks like a missing
// EXTERNAL dependency is treated as "cannot judge" and skipped.
export function deterministicGates(workspace) {
  const changed = spawnSync("git", ["-C", workspace, "diff", "--name-only"], { encoding: "utf8", timeout: 10000 });
  if (changed.status !== 0) return null;
  const pyFiles = String(changed.stdout || "").split("\n").filter((f) => f.endsWith(".py"));
  const problems = [];
  for (const f of pyFiles.slice(0, 10)) {
    // 1. Syntax gate — always valid regardless of deps.
    const syn = spawnSync("python3", ["-m", "py_compile", f], { cwd: workspace, encoding: "utf8", timeout: 15000 });
    if (syn.status !== 0) {
      problems.push(`\`${f}\` fails to compile:\n${MID(String(syn.stderr || ""), 600)}`);
      continue;
    }
    // 2. Import gate — catches circular imports / NameErrors at module level.
    //    A ModuleNotFoundError for something outside the workspace is an
    //    environment gap, not a patch bug → ignore.
    const mod = f.replace(/^src\//, "").replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
    const imp = spawnSync("python3", ["-c", `import ${mod}`], { cwd: workspace, encoding: "utf8", timeout: 20000, env: { ...process.env, PYTHONPATH: `${workspace}/src:${workspace}` } });
    if (imp.status !== 0) {
      const err = String(imp.stderr || "");
      const missing = err.match(/ModuleNotFoundError: No module named '([^']+)'/);
      const missingIsExternal = missing && !pyFiles.some((p) => p.startsWith(missing[1].split(".")[0]));
      if (!missingIsExternal && /Error/.test(err)) {
        problems.push(`\`import ${mod}\` fails:\n${MID(err, 600)}`);
      }
    }
  }
  return problems.length ? problems : null;
}

// Static diff checks (deterministic, dependency-free — pure text analysis of
// the diff + task). Each is a high-precision pattern from observed SWE-bench
// failure modes; all report-style (the model judges applicability).
export function staticDiffChecks(workspace, task) {
  const out = [];
  const d = spawnSync("git", ["-C", workspace, "diff", "-U0"], { encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (d.status !== 0) return out;
  const files = {};
  let cur = null;
  for (const line of String(d.stdout || "").split("\n")) {
    if (line.startsWith("+++ b/")) { cur = line.slice(6); files[cur] = { removed: [], added: [] }; }
    else if (cur && line.startsWith("-") && !line.startsWith("---")) files[cur].removed.push(line.slice(1));
    else if (cur && line.startsWith("+") && !line.startsWith("+++")) files[cur].added.push(line.slice(1));
  }
  // 1. Test files must not be edited (SWE-bench contract; also generally risky).
  const testFiles = Object.keys(files).filter((f) => /(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$/.test(f));
  if (testFiles.length) {
    out.push(`You modified test file(s): ${testFiles.join(", ")} — the task says do NOT edit or add tests. Revert them unless the task explicitly requires it.`);
  }
  // 2. Exception-type contract: task names an exception, change adds bare assert.
  const excs = [...new Set([...String(task).matchAll(/raise[sd]?\s+(?:an?\s+)?`?([A-Z][A-Za-z]*Error)`?/g)].map((m) => m[1]))];
  for (const [f, ch] of Object.entries(files)) {
    if (/test/.test(f) || !f.endsWith(".py")) continue;
    const addsAssert = ch.added.some((l) => /^\s*assert\s/.test(l));
    const addsExc = ch.added.some((l) => excs.some((e) => l.includes(e)));
    if (excs.length && addsAssert && !addsExc) {
      out.push(`The task mentions raising ${excs.join("/")} but your change adds a bare \`assert\` in ${f} — asserts vanish under \`python -O\` and tests check the exception type. Use \`raise ${excs[0]}(...)\`.`);
    }
  }
  // 3. Surviving identical copies of a line you changed (exact match → zero
  //    false positives; the classic missed-sibling signal).
  for (const [f, ch] of Object.entries(files)) {
    let content;
    try { content = readFileSync(join(workspace, f), "utf8").split("\n"); } catch { continue; }
    const seen = new Set();
    for (const r of ch.removed) {
      const t = r.trim();
      if (t.length < 12 || t.startsWith("#") || seen.has(t)) continue;
      seen.add(t);
      const hits = content.map((l, i) => (l.trim() === t ? i + 1 : 0)).filter(Boolean);
      if (hits.length) {
        out.push(`In ${f} you changed \`${t.slice(0, 90)}\` — but an IDENTICAL line still exists at line ${hits.slice(0, 4).join(", ")}. Check whether it needs the same fix (sibling code path).`);
      }
    }
  }
  return out.slice(0, 6);
}

/**
 * The user's actual task. The engine injects synthetic `role:"user"` wrappers
 * (project instructions, context updates, the rolling compaction summary), so
 * "first user message" no longer means "the task" — skip anything wrapped in a
 * synthetic tag. Exported for tests.
 */
export function realUserTask(messages) {
  const SYNTHETIC = /^\s*<(project_instructions|context_update|conversation_summary)>/;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (SYNTHETIC.test(text)) continue;
    return text;
  }
  return "";
}
