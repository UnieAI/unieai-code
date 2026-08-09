/**
 * edit-signals.mjs — deterministic checks over what an edit just introduced.
 *
 * Two failure modes showed up repeatedly in SWE-bench trajectories where the
 * agent edited the RIGHT file and still got the fix wrong. Both are already
 * covered by prompt instructions ("check how nearby code does it", "fix sibling
 * code paths") and both kept happening anyway — prompt guidance does not
 * penetrate reliably on open models, so they are re-implemented here as checks
 * that run at the moment of the edit and attach their finding to the tool result.
 *
 * 1. UNPRECEDENTED SYMBOL. The edit calls an API the project never calls
 *    anywhere else, while a sibling in the same file uses a different one.
 *    Real case: a patch invented `mpmath.fraction(p, q)`; the function directly
 *    above used `mpmath.mpf`, which appears 46 times in the repo and 0 times for
 *    `fraction`. Functionally defensible, but not this codebase's convention, and
 *    the project's tests pin the convention.
 *
 * 2. INCONSISTENT RETURNS. The edit made a function return a value on one path
 *    while other paths still fall out with a bare `return`/implicit None. Real
 *    case: `bulk_update()` was changed to return a row count, but its early
 *    `if not objs: return` was left alone — which is precisely what the official
 *    test checked. (Same defect pylint calls R1710.)
 *
 * Both are advisory notes, never refusals: a check that blocks a legitimate edit
 * costs far more than one the model reads and dismisses.
 */
import { spawnSync } from "node:child_process";

/** Attribute-style calls introduced by this edit, e.g. `mpmath.fraction`, `np.hstack`. */
export function introducedSymbols(oldText, newText) {
  const CALL_RE = /\b([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\s*\(/g;
  const before = new Set();
  for (const m of String(oldText || "").matchAll(CALL_RE)) before.add(`${m[1]}.${m[2]}`);
  const added = new Set();
  for (const m of String(newText || "").matchAll(CALL_RE)) {
    const sym = `${m[1]}.${m[2]}`;
    if (!before.has(sym)) added.add(sym);
  }
  // Quoted dotted names too: `_module_format('mpmath.fraction')` hides the call
  // behind a string, which is how the real miss happened.
  const STR_RE = /['"]([A-Za-z_][\w]*\.[A-Za-z_][\w]*)['"]/g;
  for (const m of String(oldText || "").matchAll(STR_RE)) before.add(m[1]);
  for (const m of String(newText || "").matchAll(STR_RE)) {
    if (!before.has(m[1])) added.add(m[1]);
  }
  return [...added];
}

/** How many times `needle` appears in the repo, via ripgrep. -1 when unknown. */
function repoCount(root, needle) {
  // The trailing "." is load-bearing: with no path argument ripgrep reads stdin,
  // and stdin is a pipe under spawnSync — so it silently finds nothing and every
  // symbol looks unprecedented. (It behaves differently from a terminal, where
  // stdin is a TTY and rg defaults to the working directory.)
  const r = spawnSync("rg", ["--no-messages", "-c", "--fixed-strings", needle, "."], { cwd: root, encoding: "utf8", timeout: 15000 });
  if (r.error || r.status > 1) return -1;
  let n = 0;
  for (const line of String(r.stdout || "").split("\n")) {
    const c = line.lastIndexOf(":");
    if (c > 0) n += Number(line.slice(c + 1)) || 0;
  }
  return n;
}

/**
 * Note about symbols this edit introduced that the project never uses elsewhere.
 * `siblingHint` names a same-family symbol that IS established, when one exists —
 * that is the actionable half ("the file next door uses mpf, you wrote fraction").
 */
export function unprecedentedSymbolNote(root, oldText, newText) {
  const introduced = introducedSymbols(oldText, newText);
  if (!introduced.length) return "";
  const notes = [];
  for (const sym of introduced.slice(0, 6)) {
    const count = repoCount(root, sym);
    if (count !== 0) continue; // established, or ripgrep unavailable
    const [ns] = sym.split(".");
    // Is the namespace itself used? Then it is the member that is novel, which is
    // the interesting case — an entirely unknown namespace is usually a new import.
    const nsCount = repoCount(root, `${ns}.`);
    if (nsCount <= 0) continue;
    notes.push(`\`${sym}\` appears nowhere else in this project (though \`${ns}.\` is used ${nsCount}×). Confirm it exists and is how this codebase does this — check the nearest similar function and follow its choice, since the project's tests are written against the established form.`);
  }
  return notes.length ? `\n${notes.map((n) => `note: ${n}`).join("\n")}` : "";
}

/**
 * Note when a Python function now returns a value on some paths but not others.
 * Pure text analysis over the enclosing `def` — no interpreter needed, so it
 * works in a workspace whose dependencies are not installed.
 */
export function inconsistentReturnNote(filePath, newText, editedSnippet) {
  if (!String(filePath || "").endsWith(".py")) return "";
  if (!/\breturn\s+\S/.test(String(editedSnippet || ""))) return ""; // the edit added no value-return
  const lines = String(newText || "").split("\n");
  // Locate the function containing the edit by finding the snippet's first line.
  const anchor = String(editedSnippet).split("\n").find((l) => l.trim().length > 3);
  if (!anchor) return "";
  const at = lines.findIndex((l) => l.includes(anchor.trim()));
  if (at < 0) return "";
  let start = -1, indent = 0;
  for (let i = at; i >= 0; i--) {
    const m = lines[i].match(/^(\s*)def\s+([A-Za-z_]\w*)/);
    if (m) { start = i; indent = m[1].length; break; }
  }
  if (start < 0) return "";
  const name = lines[start].match(/def\s+([A-Za-z_]\w*)/)?.[1] || "the function";
  const bare = [];
  let hasValue = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && (l.match(/^(\s*)/)?.[1].length ?? 0) <= indent && /\S/.test(l)) break; // left the function
    if (/^\s*return\s*$/.test(l)) bare.push(i + 1);
    else if (/^\s*return\s+\S/.test(l)) hasValue = true;
  }
  if (!hasValue || !bare.length) return "";
  return `\nnote: \`${name}\` now returns a value on some paths, but line ${bare.join(", ")} still has a bare \`return\` (implicit None). Callers — and the project's tests — usually expect every path to return the same kind of thing; update those paths too unless None is genuinely correct there.`;
}
