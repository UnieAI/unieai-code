/**
 * search-fallback.mjs — pure-JS grep/glob for hosts that have no ripgrep.
 *
 * The `grep` and `glob` tools shell out to `rg`, which is fast and respects
 * .gitignore. When `rg` is absent the tools used to hand the model an error on
 * every call, which is the worst possible outcome: its two navigation tools
 * fail 100% of the time and it burns steps rediscovering that fact. This module
 * is the fallback — slower and gitignore-blind, but it answers the question.
 *
 * Output shape deliberately matches what the tools expect back from rg:
 * absolute paths, `path:line:text` for grep, so the caller's relativising and
 * spilling logic is identical on both paths.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename, relative } from "node:path";

/** Directories that are never worth searching in a source tree. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv", "env", "dist", "build",
  ".tox", ".nox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".next", ".nuxt",
  "target", ".idea", ".vscode", ".cache", "coverage", ".gradle", "vendor",
]);
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|svgz|pdf|zip|gz|tgz|tar|xz|bz2|7z|rar|exe|dll|so|dylib|class|jar|war|wasm|mp[34]|m4a|mov|avi|mkv|woff2?|ttf|otf|eot|pyc|pyo|obj|a|lib|bin|dat|db|sqlite3?|iso|img)$/i;

const MAX_FILES = 20_000;      // walk ceiling — a runaway tree must not hang a turn
const MAX_FILE_BYTES = 2 << 20; // 2 MiB: beyond this it is data, not source
const MAX_TOTAL_MATCHES = 2_000;

/** Iterative walk (no recursion — deep trees would blow the stack). */
export function walkFiles(target, { maxFiles = MAX_FILES } = {}) {
  const out = [];
  let root;
  try { root = statSync(target); } catch { return out; }
  if (root.isFile()) return [target];
  const stack = [target];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (BINARY_EXT.test(e.name)) continue;
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/**
 * Translate a shell glob to a RegExp with the subset of syntax rg accepts:
 * `**` (any depth), `*` (within a segment), `?`, `{a,b}` alternation and
 * `[abc]` classes. Everything else is escaped.
 */
export function globToRegExp(pattern) {
  let re = "";
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") { re += ".*"; i++; if (p[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else if (c === "[") re += "[";
    else if (c === "]") re += "]";
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A glob without a separator matches the basename anywhere, as rg does. */
function makeGlobFilter(root, pattern) {
  if (!pattern) return () => true;
  const re = globToRegExp(pattern);
  const byBasename = !String(pattern).includes("/");
  return (abs) => re.test(byBasename ? basename(abs) : relative(root, abs).split("\\").join("/"));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * grep replacement. Returns rg-shaped `path:line:text` lines (absolute paths).
 * @returns {{ lines: string[], truncated: boolean, scanned: number }}
 */
export function grepFiles(root, target, { pattern, ignoreCase = false, glob = "", maxCountPerFile = 200 } = {}) {
  let re;
  try { re = new RegExp(pattern, ignoreCase ? "i" : ""); }
  catch (e) { throw new Error(`invalid pattern: ${e.message}`); }
  const keep = makeGlobFilter(root, glob);
  const lines = [];
  let truncated = false, scanned = 0;
  for (const file of walkFiles(target)) {
    if (!keep(file)) continue;
    let buf;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      buf = readFileSync(file);
    } catch { continue; }
    if (isBinary(buf)) continue;
    scanned++;
    let hits = 0;
    const text = buf.toString("utf8");
    const split = text.split("\n");
    for (let i = 0; i < split.length; i++) {
      if (!re.test(split[i])) continue;
      lines.push(`${file}:${i + 1}:${split[i]}`);
      if (++hits >= maxCountPerFile) break;
      if (lines.length >= MAX_TOTAL_MATCHES) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { lines, truncated, scanned };
}

/** glob replacement — absolute paths of files matching `pattern`. */
export function globFiles(root, target, pattern) {
  const keep = makeGlobFilter(root, pattern);
  return walkFiles(target).filter(keep);
}
