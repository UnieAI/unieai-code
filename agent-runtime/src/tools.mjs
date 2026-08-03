/**
 * tools.mjs — UnieAI Code's coding toolset for the agent-core loop (productized
 * from agent-core's examples/coding-tools) — a domainToolBuilder giving agent-core a coding
 * toolset (bash / read / write / edit) where SANDBOXING AND APPROVAL ARE THE
 * TOOL'S CONCERN, not the loop's:
 *
 * - bash runs every command under the host sandbox binary
 *   (`$UNIEAI_BIN sandbox -- <system shell> <cmd>`, i.e. UnieAI Code's
 *   seatbelt/landlock/AppContainer wrapper; the shell is `sh -c` on Unix and
 *   `cmd.exe /d /s /c` on Windows, which has no `sh` at all — see
 *   portable-exec.mjs). On a sandbox denial it escalates through the loop-provided
 *   `runCtx.requestApproval` channel and, if the host approves, re-runs
 *   unsandboxed. The loop stays sandbox-agnostic.
 * - edit is OpenCode-style search/replace (oldString must match exactly once)
 *   — the tool dialect open models handle far better than patch grammars.
 *
 * Works with any consumer that passes `requestApproval` in the loop ctx;
 * without it, escalation is declined by default (fail closed).
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { toolResult } from "../../third_party/unieai-agent-core/src/tools/_util.mjs";
import { describeImage } from "../../third_party/unieai-agent-core/src/vision.mjs";
import { DEFAULT_MAX_LINES, truncateOutput } from "../../third_party/unieai-agent-core/src/truncate-output.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spillIfLarge, readSpilled } from "./tool-output-store.mjs";
import { createFileMutationQueue } from "./file-mutation-queue.mjs";
import { createProcessManager, killTree } from "./process-manager.mjs";
import { prepareExec, shellArgv } from "./portable-exec.mjs";

// --- edit-safety pure helpers (§2 of the coding-tools change) -----------------
// Factored out (and exported) so the guards can be unit-tested without spinning
// up the engine; the executors below call them.

/** SHA-1 of the exact file text, used to detect on-disk drift since last read. */
export function hashContent(text) {
  return createHash("sha1").update(String(text ?? ""), "utf8").digest("hex");
}

/** True when `text` begins with a UTF-8 BOM (U+FEFF). */
export function hasBom(text) {
  return String(text ?? "").charCodeAt(0) === 0xfeff;
}

/** Drop a leading BOM if present (idempotent). */
export function stripBom(text) {
  const s = String(text ?? "");
  return hasBom(s) ? s.slice(1) : s;
}

/**
 * Dominant newline style of `text`: "\r\n" when CRLF outnumbers bare LF,
 * otherwise "\n". A file with no newlines is treated as LF.
 */
export function detectNewline(text) {
  const s = String(text ?? "");
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Re-encode LF-normalized `lfText` in the original file's style: re-apply the
 * dominant newline and a leading BOM if the original had one. Guarantees an
 * edit/overwrite of a CRLF-or-BOM file produces no phantom whole-file diff.
 */
export function encodeLike(lfText, { bom = false, newline = "\n" } = {}) {
  let s = String(lfText ?? "").replace(/\r\n/g, "\n"); // clean LF base
  if (newline === "\r\n") s = s.replace(/\n/g, "\r\n");
  return bom ? "﻿" + s : s;
}

/**
 * Minimal single-hunk unified diff between two texts (line-based, common
 * prefix/suffix trimmed, a couple of context lines). Powers the edit/write
 * tool cards' red/green diff rendering — small and readable, not a full LCS.
 * Returns "" when the texts are identical. Output is capped so a huge
 * rewrite can't flood the UI.
 */
export function makeDiff(before, after, { context = 2, maxLines = 160 } = {}) {
  // "" is zero lines, not one empty line — otherwise a new file's diff starts
  // with a phantom "-" removal.
  const a = String(before ?? "") === "" ? [] : String(before).split("\n");
  const b = String(after ?? "") === "" ? [] : String(after).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return "";
  const ctxStart = Math.max(0, start - context);
  const ctxEndA = Math.min(a.length, endA + context);
  const oldCount = ctxEndA - ctxStart;
  const newCount = Math.min(b.length, endB + context) - ctxStart;
  const lines = [`@@ -${ctxStart + 1},${oldCount} +${ctxStart + 1},${newCount} @@`];
  for (let i = ctxStart; i < start; i++) lines.push(" " + a[i]);
  for (let i = start; i < endA; i++) lines.push("-" + a[i]);
  for (let i = start; i < endB; i++) lines.push("+" + b[i]);
  for (let i = endA; i < ctxEndA; i++) lines.push(" " + a[i]);
  if (lines.length > maxLines) {
    const omitted = lines.length - maxLines;
    lines.length = maxLines;
    lines.push(`@@ … ${omitted} more lines … @@`);
  }
  return lines.join("\n");
}

/**
 * True when `text` mixes CRLF and bare-LF endings. Re-encoding such a file to
 * one dominant style would rewrite every minority-ending line — exactly the
 * phantom diff the fidelity path exists to prevent — so mixed files are edited
 * byte-exact (raw match) instead of via normalize→re-encode.
 */
export function isMixedNewlines(text) {
  const s = String(text ?? "");
  const crlf = (s.match(/\r\n/g) || []).length;
  const bare = (s.match(/(?<!\r)\n/g) || []).length;
  return crlf > 0 && bare > 0;
}

/**
 * Resolve symlinks on the deepest EXISTING ancestor of `p`, then re-append the
 * not-yet-existing remainder. `path.resolve` alone is lexical, so a symlink
 * inside the workspace pointing outside would pass a string containment check
 * while the actual write lands elsewhere.
 */
function realDeep(p) {
  let base = p;
  const rest = [];
  for (;;) {
    try {
      return rest.length ? join(realpathSync(base), ...rest) : realpathSync(base);
    } catch {
      const parent = dirname(base);
      if (parent === base) return p; // hit the fs root without an existing ancestor
      rest.unshift(basename(base));
      base = parent;
    }
  }
}

/**
 * True when `targetPath` (resolved against `workspace`) lands OUTSIDE the
 * workspace root. Handles `..` escapes, absolute paths, AND symlinks — both
 * sides are realpath-resolved (deepest existing ancestor) before the
 * containment check, so `ws/link -> /etc` can't smuggle a write outside, and a
 * workspace itself behind a symlink (e.g. /tmp on macOS) compares correctly.
 */
export function isExternalPath(workspace, targetPath) {
  const root = realDeep(resolve(workspace || process.cwd()));
  const abs = realDeep(resolve(root, String(targetPath ?? "")));
  return abs !== root && !abs.startsWith(root + sep);
}

// Smart-tool feedback (tool-level intelligence beats prompt exhortation): after
// a Python file is written/edited, verify it instantly and attach the verdict
// to the SAME tool result — the model gets the signal at the moment of action,
// not at a completion-time gate N steps later.
function pyInstantChecks(absPath, { oldString = null, fileBody = null } = {}) {
  if (!absPath.endsWith(".py")) return "";
  const notes = [];
  try {
    execFileSync("python3", ["-m", "py_compile", absPath], { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // No python3 on this machine (or the spawn itself failed/timed out) is NOT
    // a syntax error — reporting it as one sends the model chasing a phantom
    // bug. Only a real py_compile failure gets surfaced.
    const spawnFailure = e?.code === "ENOENT" || e?.code === "ETIMEDOUT" || /ENOENT/.test(String(e?.message || ""));
    if (!spawnFailure) {
      const err = String(e.stderr || e.message || "").slice(-500);
      notes.push(`⚠ file no longer compiles:\n${err}\nFix this before anything else.`);
    }
  }
  // Sibling signal: a line just replaced still exists verbatim elsewhere.
  if (oldString && fileBody) {
    const lines = fileBody.split("\n").map((l) => l.trim());
    const seen = new Set();
    for (const raw of String(oldString).split("\n")) {
      const t = raw.trim();
      if (t.length < 12 || t.startsWith("#") || seen.has(t)) continue;
      seen.add(t);
      const hits = lines.map((l, i) => (l === t ? i + 1 : 0)).filter(Boolean);
      if (hits.length) notes.push(`note: an identical copy of the line you just changed (\`${t.slice(0, 80)}\`) remains at line ${hits.slice(0, 3).join(", ")} — check if it needs the same fix.`);
    }
  }
  return notes.length ? `\n${notes.join("\n")}` : "";
}

// "access is denied" is the Windows (AppContainer) wording for the same thing
// seatbelt/landlock report as EPERM/EACCES; without it a denial on Windows
// reads as an ordinary non-zero exit and never reaches the approval prompt.
const SANDBOX_DENIED = /operation not permitted|permission denied|access is denied|sandbox/i;

// --- fuzzy edit matching (ported from grok-build's seek_sequence 4-tier design) ---
// Models mangle whitespace and typographic punctuation when echoing file text.
// Escalating normalization tiers recover the edit instead of bouncing the model
// through read→retry loops: exact → rstrip → trim → unicode-normalized.
const UNICODE_MAP = [
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-"], // dashes
  [/[\u2018\u2019\u201A\u201B]/g, "'"], // smart single quotes
  [/[\u201C\u201D\u201E\u201F]/g, '"'], // smart double quotes
  [/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " "] // exotic spaces (NBSP, en/em, zero-width, ideographic)
];
const normUnicode = (s) => UNICODE_MAP.reduce((acc, [re, to]) => acc.replace(re, to), s);
const TIERS = [
  { name: "exact", fn: (l) => l },
  { name: "ignoring trailing whitespace", fn: (l) => l.replace(/[ \t]+$/, "") },
  { name: "ignoring surrounding whitespace", fn: (l) => l.trim() },
  { name: "normalizing unicode punctuation", fn: (l) => normUnicode(l.trim()) }
];

/**
 * Find `pattern` lines inside `fileLines` under escalating normalization.
 * Returns { indices, tier } for the FIRST tier that yields any match, so a
 * stricter match is never shadowed by a looser one.
 */
function seekLines(fileLines, patternLines) {
  for (const tier of TIERS) {
    const want = patternLines.map(tier.fn);
    const indices = [];
    outer: for (let i = 0; i + want.length <= fileLines.length; i++) {
      for (let j = 0; j < want.length; j++) {
        if (tier.fn(fileLines[i + j]) !== want[j]) continue outer;
      }
      indices.push(i);
    }
    if (indices.length > 0) return { indices, tier: tier.name };
  }
  return { indices: [], tier: null };
}

// Middle truncation (codex-rs style): long tool output keeps BOTH the head
// (what ran, first errors) and the tail (final result, summary line) — the
// middle is the expendable part. Head-only slicing hides exactly the part the
// model usually needs (the outcome).
/**
 * Truncate to whole lines within a line AND a byte budget.
 *
 * A character slice cut through the middle of a line, which for code or a log
 * hands the model a fragment it cannot distinguish from real content. `mode`
 * defaults to keeping both ends; callers reading a log want `tail`.
 */
function truncateMiddle(s, max = 8000, mode = "middle") {
  return truncateOutput(s, { maxBytes: max, maxLines: DEFAULT_MAX_LINES, mode }).content;
}

export function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  // On Windows the CLI is usually an npm `.cmd` shim, which execFile cannot
  // launch directly; prepareExec resolves it (and pre-quotes argv when it has
  // to fall back to cmd.exe, since Node escapes nothing under `shell: true`).
  const spec = prepareExec(cmd, args);
  return new Promise((done) => {
    // Node's own `timeout` calls child.kill() on the DIRECT child only — the
    // sandbox wrapper — leaving the `sh -c` beneath it and everything it
    // started running, unowned, with nothing left to report or stop them.
    // Spawning as a process-group leader and killing the group on timeout
    // reaches the whole tree. The cost is that an abrupt death of THIS process
    // mid-command now leaves a detached group behind; a timeout leaking the
    // real work is the worse of the two, and it happens far more often.
    let timer = null;
    const child = execFile(spec.file, spec.args, { cwd, maxBuffer: 4 * 1024 * 1024, shell: spec.shell, windowsHide: true, detached: process.platform !== "win32" }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      // A spawn failure (binary missing / not executable) reports a STRING errno
      // in error.code and never actually ran, so it has no exit status. Keep it
      // distinct from a command that ran and exited non-zero, so the caller can
      // explain the environment problem instead of surfacing a bare "exit ENOENT".
      const spawnError = error && typeof error.code === "string" ? error.code : null;
      done({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        spawnError,
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // SIGKILL rather than a graceful escalation: this path already waited
        // the full budget, and the caller is about to report a timeout either
        // way, so a second grace period only delays the answer.
        killTree(child, "SIGKILL");
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

/** Reduce an HTML document to readable text for the model. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Search backends for `web_search`, keyed by `UNIEAI_SEARCH_PROVIDER`.
 *
 * Each adapter normalizes its vendor's payload to `{ title, url, snippet }` so
 * the tool's own output shape does not change when a consumer switches vendor.
 * Adding a provider means adding an entry here — nothing else moves.
 */
export const SEARCH_PROVIDERS = {
  async brave({ query, limit, apiKey, signal }) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const res = await globalThis.fetch(url, {
      signal,
      headers: { accept: "application/json", "x-subscription-token": apiKey },
    });
    if (!res.ok) throw new Error(`Brave search returned HTTP ${res.status} ${res.statusText}`);
    const body = await res.json();
    return (body?.web?.results || []).slice(0, limit).map((r) => ({
      title: String(r?.title || "(untitled)"),
      url: String(r?.url || ""),
      snippet: htmlToText(String(r?.description || "")).slice(0, 500),
    }));
  },
  async tavily({ query, limit, apiKey, signal }) {
    const res = await globalThis.fetch("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
    });
    if (!res.ok) throw new Error(`Tavily search returned HTTP ${res.status} ${res.statusText}`);
    const body = await res.json();
    return (body?.results || []).slice(0, limit).map((r) => ({
      title: String(r?.title || "(untitled)"),
      url: String(r?.url || ""),
      snippet: String(r?.content || "").slice(0, 500),
    }));
  },
};

/** Extensions `read_media_file` will hand to the vision model, and their MIME types. */
export const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * Largest image handed to a vision model.
 *
 * Base64 inflates by a third and the result rides in the request body, so a
 * generous cap here turns into a very expensive call. Refusing with a clear
 * message beats silently truncating an image into something unreadable.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function buildCodingTools({ workspace, sandboxBin = process.env.UNIEAI_BIN || "unieai", webAccess = false, allowExternal = false, externalAllowlist = [], visionModel = null, callModelJson = null, visionOptions = {} } = {}) {
  const root = resolve(workspace || process.cwd());

  // §2.1 content-hash staleness guard: resolved abs path → SHA-1 of the exact
  // bytes the model last saw (via `read`, or the last successful write/edit).
  // A write/edit that finds a different on-disk hash refuses — the model raced
  // an external change and must re-read before mutating.
  const readHashes = new Map();

  // Per-file serialization for write/edit. The loop runs a step's tool calls
  // concurrently, so two edits to one file can overlap; the staleness guard
  // then refuses the second one even though it was perfectly valid. Queuing per
  // canonical path lets both apply in order. Scoped to this toolset instance so
  // concurrent requests never share locks.
  const mutations = createFileMutationQueue();

  // One manager per toolset instance, so a session can never see or stop
  // another session's jobs. Created lazily: most sessions never start a
  // background process, and an unused manager still installs an exit hook.
  let processesInstance = null;
  const processes = () => (processesInstance ||= createProcessManager({ workspace: root, sandboxBin }));

  // §2.3 external-directory gate: an explicit opt-in allowlist of absolute paths
  // the host has pre-approved outside the workspace root.
  const externalAllow = new Set((Array.isArray(externalAllowlist) ? externalAllowlist : []).map((p) => resolve(root, p)));

  // Refuse (or, if the host wired an fs approval channel, escalate) any target
  // that resolves outside the workspace. A distinct `external_directory` kind so
  // the host can gate it separately from normal in-workspace edits. Returns
  // { ok:true } when allowed, else { ok:false, message } with a clear refusal.
  async function gateExternal(abs, filePath, runCtx = {}) {
    if (!isExternalPath(root, filePath)) return { ok: true };
    if (allowExternal || externalAllow.has(abs)) return { ok: true };
    if (typeof runCtx?.requestApproval === "function") {
      const decision = await runCtx.requestApproval({ tool: "fs", kind: "external_directory", action: "access a path outside the workspace", detail: abs });
      if (decision === "acceptForSession") {
        externalAllow.add(abs); // remember: don't re-prompt for this path again this session
        return { ok: true };
      }
      if (decision === "accept") return { ok: true };
    }
    return { ok: false, message: `error: ${filePath} resolves outside the workspace root (${abs}); external-directory access requires a separate approval that was not granted. Work inside the workspace instead.` };
  }

  // §2.1: compare current on-disk bytes to what the model last saw. Returns a
  // refusal string when the file drifted since the last read, else null. No
  // prior read (create-new / first-write flows) is allowed through.
  function staleGuard(abs, filePath, currentText) {
    const prev = readHashes.get(abs);
    if (prev == null) return null;
    if (hashContent(currentText) !== prev) {
      return `File ${filePath} changed on disk since you last read it. Re-read it, then edit again.`;
    }
    return null;
  }

  // fetch is an OPTIONAL domain tool gated by the consumer's web-access toggle;
  // the loop stays unaware of it. Off by default so a plain coding session has
  // no network reach beyond what bash's sandbox already governs.
  const fetchSchema = { type: "function", function: { name: "fetch", description: "Fetch an http(s) URL and return its content as readable text (HTML is reduced to text). Use to read documentation pages or HTTP APIs the task references.", parameters: { type: "object", properties: { url: { type: "string", description: "absolute http(s) URL" } }, required: ["url"] } } };

  // web_search finds URLs; `fetch` reads them. Keeping them separate means the
  // model pays for a full page only once it has picked a promising result.
  //
  // No provider is bundled: a search API means a vendor account and a per-query
  // bill, which is the consumer's decision, not the runtime's. The provider is
  // selected by env so adding one is configuration rather than a code change.
  const searchSchema = { type: "function", function: { name: "web_search", description: "Search the web and return result titles, URLs, and snippets. Use it to FIND pages; then call fetch on the URLs worth reading.", parameters: { type: "object", properties: { query: { type: "string", description: "the search query" }, maxResults: { type: "number", description: "how many results to return (1-10, default 5)" } }, required: ["query"] } } };

  // `ask` is a structured elicitation primitive, distinct from approval: it lets
  // the model put a real choice to the user (multiple options) and block on the
  // answer. The host renders it (TUI menu / VS Code card) via runCtx.requestQuestion.
  const askSchema = { type: "function", function: { name: "ask", description: "Ask the user a question with a fixed set of options when you genuinely need a decision to proceed. Blocks until they choose. Use sparingly — prefer acting when the answer is inferable.", parameters: { type: "object", properties: { question: { type: "string", description: "the question to ask" }, options: { type: "array", items: { type: "string" }, description: "2–5 concrete options" } }, required: ["question", "options"] } } };

  const schemas = [
    { type: "function", function: { name: "bash", description: "Run a shell command in the workspace (sandboxed). Prefer `rg` for searching.", parameters: { type: "object", properties: { cmd: { type: "string", description: "the command line to run" } }, required: ["cmd"] } } },
    { type: "function", function: { name: "read", description: "Read a file (workspace-relative path).", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
    { type: "function", function: { name: "write", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
    { type: "function", function: { name: "edit", description: "Edit a file by exact search/replace. oldString must appear exactly once.", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } },
    { type: "function", function: { name: "read_output", description: "Query a large tool output that was spilled to storage (its preview showed an id). For record data (a JSON array), filter and page through RECORDS — never try to pull it all into the conversation. For plain text, filter to matching lines.", parameters: { type: "object", properties: { id: { type: "string", description: "the output id from the preview marker" }, grep: { type: "string", description: "substring or /regex/; keeps matching records (or lines, for text)" }, fields: { type: "string", description: "for records: comma-separated keys to keep, e.g. \"id,name\" — the main way to shrink a page" }, offset: { type: "number", description: "for records: index of the first record to return (default 0)" }, limit: { type: "number", description: "for records: how many records to return (default 50)" } }, required: ["id"] } } },
    // grep/glob are first-class rather than left to `bash`+rg for the same reason
    // `edit` is search/replace: open models compose a JSON argument object far
    // more reliably than a correctly-quoted shell pipeline. They also return
    // structured, spillable output and never need the sandbox escalation path.
    { type: "function", function: { name: "grep", description: "Search file contents for a regular expression and return matching lines with their file and line number. Respects .gitignore. Prefer this over running rg through bash.", parameters: { type: "object", properties: { pattern: { type: "string", description: "regular expression to search for" }, path: { type: "string", description: "optional workspace-relative directory or file to search (defaults to the workspace root)" }, glob: { type: "string", description: "optional file filter, e.g. *.ts" }, ignoreCase: { type: "boolean", description: "case-insensitive match (default false)" } }, required: ["pattern"] } } },
    { type: "function", function: { name: "glob", description: "List workspace files whose paths match a glob pattern, e.g. src/**/*.rs. Respects .gitignore. Use to discover files before reading them.", parameters: { type: "object", properties: { pattern: { type: "string", description: "glob pattern to match against file paths" }, path: { type: "string", description: "optional workspace-relative directory to list under (defaults to the workspace root)" } }, required: ["pattern"] } } },
    // read_media_file DELEGATES: the vision model looks, and only prose comes
    // back. That is why this tool exists even when the main model is text-only.
    { type: "function", function: { name: "read_media_file", description: "Look at an image file (png/jpg/gif/webp/bmp) and get a written description of it. Use for screenshots, diagrams, and error dialogs. Ask a specific question when you need one detail rather than a full description.", parameters: { type: "object", properties: { filePath: { type: "string", description: "workspace-relative path to the image" }, prompt: { type: "string", description: "optional question about the image; omit for a full description" } }, required: ["filePath"] } } },
    // Background execution. `bash` blocks and times out, so a dev server, a
    // watch build, or a long test run could not be started at all — the model
    // had to either avoid them or watch one eat its whole timeout budget.
    { type: "function", function: { name: "run_background", description: "Start a long-running command in the background and get a handle back immediately. Use for dev servers, watch builds, and test runs that outlive a normal bash call. Poll it with read_process; stop it with stop_process.", parameters: { type: "object", properties: { command: { type: "string", description: "the command line to run" }, label: { type: "string", description: "optional short name to recognise it by later" } }, required: ["command"] } } },
    { type: "function", function: { name: "list_processes", description: "List background processes with their status, exit code, uptime, and how much output is buffered.", parameters: { type: "object", properties: { includeExited: { type: "boolean", description: "include processes that have already finished (default true)" } } } } },
    { type: "function", function: { name: "read_process", description: "Read a background process's output. Pass the cursor from a previous read to get ONLY what is new since then — that is the cheap way to poll for progress.", parameters: { type: "object", properties: { id: { type: "string", description: "the process handle from run_background" }, cursor: { type: "number", description: "cursor from a previous read; omit to get the most recent output" }, tail: { type: "number", description: "how many recent lines to return when no cursor is given" } }, required: ["id"] } } },
    { type: "function", function: { name: "stop_process", description: "Stop a background process and everything it started, or all of them at once.", parameters: { type: "object", properties: { id: { type: "string", description: "the process handle; omit together with all=true to stop everything" }, all: { type: "boolean", description: "stop every background process" } } } } },
    askSchema,
  ];
  if (webAccess) schemas.push(fetchSchema, searchSchema);

  // A sub-agent runs off the main thread with no channel to the user: `ask`
  // there would either hang or be auto-declined, and the user would be answering
  // a question they never saw asked. Everything else — files, shell, search —
  // is exactly what a sub-agent is delegated to do, so it all carries over.
  return async ({ forSubagent = false } = {}) => ({
    label: "coding",
    schemas: forSubagent
      ? schemas.filter((s) => s.function?.name !== "ask")
      : schemas,
    // `ask` blocks on the user; the loop exempts it from the tool timeout.
    interactiveTools: forSubagent ? [] : ["ask"],
    executors: {
      async bash(args, runCtx = {}) {
        const cmd = String(args?.cmd || "").trim();
        if (!cmd) return toolResult({ ok: false, modelText: "error: cmd is required" });
        const sandboxed = await run(sandboxBin, ["sandbox", "--", ...shellArgv(cmd)], { cwd: root });
        if (sandboxed.spawnError) {
          return toolResult({ ok: false, modelText: `error: could not launch the UnieAI Code sandbox binary \`${sandboxBin}\` (${sandboxed.spawnError}). It is not on PATH for this process. In VS Code set \`unieai-code.executablePath\` to the absolute path of the \`unieai\` binary (\`which unieai\` in a terminal), or set the UNIEAI_BIN environment variable. Until then, use the read/write/edit tools instead of shell commands.` });
        }
        const denied = sandboxed.code !== 0 && SANDBOX_DENIED.test(sandboxed.stderr + sandboxed.stdout);
        if (!denied) {
          const out = spillIfLarge(sandboxed.stdout + sandboxed.stderr, { id: "bash", fallbackTruncate: () => truncateMiddle(sandboxed.stdout + sandboxed.stderr) });
          return toolResult({ ok: sandboxed.code === 0, modelText: `exit ${sandboxed.code}\n${out.modelText}` });
        }
        // Sandbox denial → escalate through the host's approval channel.
        const decision = runCtx.requestApproval
          ? await runCtx.requestApproval({ tool: "bash", action: "run outside the sandbox", detail: cmd })
          : "decline";
        if (decision !== "accept" && decision !== "acceptForSession") {
          return toolResult({ ok: false, modelText: `exit ${sandboxed.code}\n(blocked by sandbox; escalation ${runCtx.requestApproval ? "declined by user" : "unavailable"})\n${sandboxed.stderr.slice(0, 2000)}` });
        }
        // The loop aborts this call's signal when the tool call has timed out
        // (or the turn was interrupted). An approval that arrives AFTER that
        // must not fire the unsandboxed rerun in the background — the model
        // already moved on and nobody would see the result.
        if (runCtx.abortSignal?.aborted) {
          return toolResult({ ok: false, modelText: "(approval arrived after the tool call was abandoned — command NOT executed; ask again if still needed)" });
        }
        const [shell, ...shellArgs] = shellArgv(cmd);
        const raw = await run(shell, shellArgs, { cwd: root });
        return toolResult({ ok: raw.code === 0, modelText: `exit ${raw.code} (approved, unsandboxed)\n${truncateMiddle(raw.stdout + raw.stderr)}` });
      },
      async read(args, runCtx = {}) {
        try {
          const filePath = String(args?.filePath || "");
          const abs = resolve(root, filePath);
          const gate = await gateExternal(abs, filePath, runCtx);
          if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });
          const body = await readFile(abs, "utf8");
          // §2.1: remember exactly what the model saw, so a later edit/write can
          // detect an intervening on-disk change.
          readHashes.set(abs, hashContent(body));
          const out = spillIfLarge(body, { id: "read", limit: 32_000, fallbackTruncate: () => body.slice(0, 32_000) });
          return toolResult({
            modelText: out.modelText,
            metadata: { timelineEvent: { type: "file_read", path: filePath, lines: body.split("\n").length } }
          });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async read_output(args) {
        const r = readSpilled(String(args?.id || ""), {
          grep: String(args?.grep || ""),
          fields: String(args?.fields || ""),
          offset: Number(args?.offset) || 0,
          limit: Number(args?.limit) || 0,
        });
        return toolResult({ ok: r.ok, modelText: r.text });
      },
      async grep(args, runCtx = {}) {
        const pattern = String(args?.pattern || "");
        if (!pattern) return toolResult({ ok: false, modelText: "error: pattern is required" });
        const rel = String(args?.path || "");
        const abs = resolve(root, rel);
        const gate = await gateExternal(abs, rel || ".", runCtx);
        if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });

        const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--max-count", "200"];
        if (args?.ignoreCase) rgArgs.push("--ignore-case");
        if (args?.glob) rgArgs.push("--glob", String(args.glob));
        // `--` keeps a pattern that starts with `-` from being read as a flag.
        rgArgs.push("--regexp", pattern, "--", abs);

        const res = await run("rg", rgArgs, { cwd: root });
        if (res.spawnError) {
          return toolResult({ ok: false, modelText: `error: could not run ripgrep (${res.spawnError}). Install rg, or fall back to the bash tool.` });
        }
        // rg exits 1 for "no matches", which is a successful search, not a failure.
        if (res.code === 1 && !res.stderr.trim()) {
          return toolResult({ ok: true, modelText: `No matches for /${pattern}/.` });
        }
        if (res.code !== 0 && res.code !== 1) {
          return toolResult({ ok: false, modelText: `error: ripgrep exited ${res.code}\n${res.stderr.slice(0, 2000)}` });
        }
        // Paths come back absolute because we searched an absolute root; make them
        // workspace-relative so they line up with what read/edit expect.
        const body = res.stdout.split("\n").map((l) => (l.startsWith(root + sep) ? l.slice(root.length + 1) : l)).join("\n");
        const matches = body.split("\n").filter(Boolean).length;
        const out = spillIfLarge(body, { id: "grep", fallbackTruncate: () => truncateMiddle(body) });
        return toolResult({
          modelText: `${matches} matching line(s)\n${out.modelText}`,
          metadata: { timelineEvent: { type: "grep", pattern, matches } }
        });
      },
      async glob(args, runCtx = {}) {
        const pattern = String(args?.pattern || "");
        if (!pattern) return toolResult({ ok: false, modelText: "error: pattern is required" });
        const rel = String(args?.path || "");
        const abs = resolve(root, rel);
        const gate = await gateExternal(abs, rel || ".", runCtx);
        if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });

        const res = await run("rg", ["--files", "--glob", pattern, "--", abs], { cwd: root });
        if (res.spawnError) {
          return toolResult({ ok: false, modelText: `error: could not run ripgrep (${res.spawnError}). Install rg, or fall back to the bash tool.` });
        }
        if (res.code !== 0 && res.code !== 1) {
          return toolResult({ ok: false, modelText: `error: ripgrep exited ${res.code}\n${res.stderr.slice(0, 2000)}` });
        }
        const files = res.stdout.split("\n").filter(Boolean)
          .map((p) => (p.startsWith(root + sep) ? p.slice(root.length + 1) : p));
        if (!files.length) return toolResult({ ok: true, modelText: `No files match ${pattern}.` });
        const body = files.join("\n");
        const out = spillIfLarge(body, { id: "glob", fallbackTruncate: () => truncateMiddle(body) });
        return toolResult({
          modelText: `${files.length} file(s)\n${out.modelText}`,
          metadata: { timelineEvent: { type: "glob", pattern, files: files.length } }
        });
      },
      async write(args, runCtx = {}) {
        try {
          const filePath = String(args?.filePath || "");
          const abs = resolve(root, filePath);
          const gate = await gateExternal(abs, filePath, runCtx);
          if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });
          // Serialized per file: a concurrent edit landing between the read
          // below and the write would trip the staleness guard and lose an
          // otherwise valid change.
          return await mutations.run(abs, async () => {
          // When OVERWRITING an existing file, apply the same staleness guard and
          // newline/BOM fidelity as `edit` (a create-new write skips both).
          let existing = null;
          try { existing = await readFile(abs, "utf8"); } catch { existing = null; }
          let content = String(args?.content ?? "");
          if (existing !== null) {
            const stale = staleGuard(abs, filePath, existing);
            if (stale) return toolResult({ ok: false, modelText: stale });
            // §2.2: re-encode the model's (LF) content in the original's style so
            // overwriting a CRLF/BOM file doesn't manufacture a whole-file diff.
            // Mixed-ending originals are left as the model wrote them — forcing
            // one dominant style onto them would rewrite the minority lines too.
            if (!isMixedNewlines(existing)) {
              content = encodeLike(stripBom(content), { bom: hasBom(existing), newline: detectNewline(existing) });
            }
          }
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, content, "utf8");
          readHashes.set(abs, hashContent(content));
          return toolResult({
            modelText: `wrote ${args.filePath}${pyInstantChecks(abs)}`,
            metadata: {
              timelineEvent: {
                type: "file_diff",
                path: filePath,
                kind: existing === null ? "add" : "update",
                diff: makeDiff(existing ?? "", content)
              }
            }
          });
          });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async edit(args, runCtx = {}) {
        try {
          const filePath = String(args?.filePath || "");
          const abs = resolve(root, filePath);
          const gate = await gateExternal(abs, filePath, runCtx);
          if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });
          // Serialized per file — see `write`. Two edits to one file in the same
          // step used to race, and the staleness guard rejected the loser.
          return await mutations.run(abs, async () => {
          const rawBefore = await readFile(abs, "utf8");
          // §2.1: refuse if the file drifted on disk since the model last read it.
          const stale = staleGuard(abs, filePath, rawBefore);
          if (stale) return toolResult({ ok: false, modelText: stale });
          const oldRaw = String(args?.oldString ?? "");
          const newRaw = String(args?.newString ?? "");
          // Byte-exact path first: when the model echoed the file's exact bytes
          // (BOM/CRLF included), replace in place with ZERO re-encoding — the
          // only path that is correct for mixed-ending files. The function-form
          // replacement is deliberate: a string replacement would expand $&/$$
          // patterns in newString and silently corrupt the write.
          const rawHits = oldRaw ? rawBefore.split(oldRaw).length - 1 : 0;
          if (rawHits === 1) {
            const rawResult = rawBefore.replace(oldRaw, () => newRaw);
            await writeFile(abs, rawResult, "utf8");
            readHashes.set(abs, hashContent(rawResult));
            return toolResult({
              modelText: `edited ${args.filePath}${pyInstantChecks(abs, { oldString: oldRaw, fileBody: rawResult })}`,
              metadata: { timelineEvent: { type: "file_diff", path: filePath, kind: "update", diff: makeDiff(rawBefore, rawResult) } }
            });
          }
          // §2.2: match/replace on a normalized-LF, BOM-stripped view, then
          // re-encode the result in the original's dominant style. Refused for
          // mixed-ending files — re-encoding would rewrite every minority-ending
          // line, the very phantom diff this path exists to prevent.
          if (isMixedNewlines(rawBefore)) {
            return toolResult({ ok: false, modelText: "error: oldString not found byte-exactly, and this file mixes CRLF and LF line endings — re-read the file and copy the exact text including line endings" });
          }
          const bom = hasBom(rawBefore);
          const newline = detectNewline(rawBefore);
          const before = stripBom(rawBefore).replace(/\r\n/g, "\n");
          const oldString = oldRaw.replace(/\r\n/g, "\n");
          const newString = newRaw.replace(/\r\n/g, "\n");
          const commit = async (lfResult, extraNote) => {
            const encoded = encodeLike(lfResult, { bom, newline });
            await writeFile(abs, encoded, "utf8");
            readHashes.set(abs, hashContent(encoded)); // keep the snapshot current for the next edit
            return toolResult({
              modelText: `edited ${args.filePath}${extraNote}${pyInstantChecks(abs, { oldString, fileBody: lfResult })}`,
              metadata: { timelineEvent: { type: "file_diff", path: filePath, kind: "update", diff: makeDiff(rawBefore, encoded) } }
            });
          };
          // Fast path: exact substring, must be unique.
          const hits = before.split(oldString).length - 1;
          if (hits === 1) {
            return commit(before.replace(oldString, () => newString), "");
          }
          if (hits > 1) return toolResult({ ok: false, modelText: `error: oldString matches ${hits} times — include more surrounding context` });
          // Fuzzy path: line-based match under escalating normalization, so
          // whitespace/punctuation drift in the model's copy still lands.
          const fileLines = before.split("\n");
          let patternLines = oldString.split("\n");
          let found = seekLines(fileLines, patternLines);
          if (!found.indices.length && patternLines.length > 1 && patternLines[patternLines.length - 1] === "") {
            patternLines = patternLines.slice(0, -1); // spurious trailing newline retry
            found = seekLines(fileLines, patternLines);
          }
          if (!found.indices.length) return toolResult({ ok: false, modelText: "error: oldString not found — read the file and copy the exact text" });
          if (found.indices.length > 1) return toolResult({ ok: false, modelText: `error: oldString matches ${found.indices.length} times (${found.tier}) — include more surrounding context` });
          fileLines.splice(found.indices[0], patternLines.length, ...newString.split("\n"));
          const note = found.tier === "exact" ? "" : ` (matched ${found.tier})`;
          return commit(fileLines.join("\n"), note);
          });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      // Registered only when webAccess is on (see schemas above); if the model
      // somehow calls it while off, fail closed rather than reaching the network.
      async fetch(args) {
        if (!webAccess) return toolResult({ ok: false, modelText: "error: web access is disabled — enable the 上網 toggle to fetch URLs" });
        const raw = String(args?.url || "").trim();
        let url;
        try { url = new URL(raw); } catch { return toolResult({ ok: false, modelText: "error: url must be an absolute http(s) URL" }); }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return toolResult({ ok: false, modelText: `error: unsupported protocol ${url.protocol} — only http and https` });
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        try {
          const res = await globalThis.fetch(raw, {
            signal: ctrl.signal,
            redirect: "follow",
            headers: { "user-agent": "UnieAI-Code/agent-core", accept: "text/html,application/json,text/plain,*/*" },
          });
          const contentType = res.headers.get("content-type") || "";
          const body = await res.text();
          const text = /html/i.test(contentType) ? htmlToText(body) : body;
          // Spill rather than truncate. A hard cut here DESTROYED the middle of
          // every large response — an API page of 10k records came back as two
          // fragments with no way to recover the rest. Spilling keeps the whole
          // body and lets read_output page through it.
          const out = spillIfLarge(text, { id: "fetch", limit: 24_000, fallbackTruncate: () => truncateMiddle(text, 24_000) });
          return toolResult({ ok: res.ok, modelText: `HTTP ${res.status} ${res.statusText} · ${contentType}\n\n${out.modelText}` });
        } catch (e) {
          const msg = e?.name === "AbortError" ? "request timed out after 30s" : (e?.message || String(e));
          return toolResult({ ok: false, modelText: `error: ${msg}` });
        } finally {
          clearTimeout(timer);
        }
      },
      async read_media_file(args, runCtx = {}) {
        const filePath = String(args?.filePath || "");
        if (!filePath) return toolResult({ ok: false, modelText: "error: filePath is required" });

        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        const mime = IMAGE_MIME_TYPES[ext];
        if (!mime) {
          return toolResult({ ok: false, modelText: `error: ${filePath} is not a supported image (${Object.keys(IMAGE_MIME_TYPES).join(", ")}). Use read for text files.` });
        }

        // Check the vision model BEFORE touching the file: telling the model to
        // go configure one is more useful than a read error it cannot act on.
        if (!visionModel) {
          return toolResult({ ok: false, modelText: "error: no vision model is configured, so images cannot be read. Tell the user to run /vision-model (or /vlm) to pick and verify one, then try again." });
        }
        if (typeof callModelJson !== "function") {
          return toolResult({ ok: false, modelText: "error: image reading is unavailable in this environment." });
        }

        const abs = resolve(root, filePath);
        const gate = await gateExternal(abs, filePath, runCtx);
        if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });

        let bytes;
        try {
          bytes = await readFile(abs);
        } catch (e) {
          return toolResult({ ok: false, modelText: `error: ${e.message}` });
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
          const mb = (bytes.length / 1024 / 1024).toFixed(1);
          return toolResult({ ok: false, modelText: `error: ${filePath} is ${mb}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit for images. Resize it first.` });
        }

        const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
        const described = await describeImage({
          model: visionModel,
          dataUrl,
          prompt: args?.prompt,
          callModelJson,
          options: visionOptions,
        });
        if (!described.ok) return toolResult({ ok: false, modelText: `error: ${described.text}` });

        return toolResult({
          modelText: `${filePath} (described by ${described.model}):\n\n${described.text}`,
          metadata: { timelineEvent: { type: "media_read", path: filePath, bytes: bytes.length, model: described.model } },
        });
      },
      async run_background(args) {
        const started = processes().start({ command: String(args?.command || ""), label: String(args?.label || "") });
        if (!started.ok) return toolResult({ ok: false, modelText: `error: ${started.error}` });
        return toolResult({
          modelText: `Started ${started.id} (pid ${started.pid}). It runs until it exits or you call stop_process. Poll it with read_process("${started.id}").`,
          metadata: { timelineEvent: { type: "process_start", id: started.id, command: String(args?.command || "").slice(0, 200) } },
        });
      },
      async list_processes(args) {
        const rows = processes().list({ includeExited: args?.includeExited !== false });
        if (!rows.length) return toolResult({ ok: true, modelText: "No background processes." });
        const body = rows.map((r) => {
          const life = r.exitedAt ? `exit ${r.exitCode ?? r.signal ?? "?"}` : `up ${Math.round(r.uptimeMs / 1000)}s`;
          return `${r.id}  ${r.status.padEnd(7)} ${life.padEnd(12)} ${r.outputLines} line(s)  ${String(r.command).slice(0, 80)}`;
        }).join("\n");
        return toolResult({ modelText: `${rows.length} process(es)\n${body}` });
      },
      async read_process(args) {
        const out = processes().read(String(args?.id || ""), {
          cursor: Number.isFinite(Number(args?.cursor)) ? Number(args.cursor) : undefined,
          tail: Number(args?.tail) || undefined,
        });
        if (!out.ok) return toolResult({ ok: false, modelText: `error: ${out.error}` });
        const state = out.running ? "running" : `${out.status} (${out.exitCode ?? out.signal ?? "?"})`;
        // The dropped count is reported rather than hidden: output is a bounded
        // ring, so an error that scrolled past is genuinely gone and the model
        // should know to look in a redirected log instead of assuming it saw all.
        const dropped = out.droppedLines ? ` — ${out.droppedLines} earlier line(s) dropped from the buffer` : "";
        const text = out.text ? `\n${truncateMiddle(out.text, 16_000, "tail")}` : "\n(no new output)";
        return toolResult({ modelText: `${out.id} ${state}, cursor ${out.cursor}${dropped}${text}` });
      },
      async stop_process(args) {
        const manager = processes();
        if (args?.all) {
          const results = await manager.stopAll();
          return toolResult({ modelText: `Stopped ${results.length} process(es).` });
        }
        const id = String(args?.id || "").trim();
        if (!id) return toolResult({ ok: false, modelText: "error: stop_process needs an `id`, or `all: true`" });
        const result = await manager.stop(id);
        if (!result.ok) return toolResult({ ok: false, modelText: `error: ${result.error ?? `could not stop ${id}`}` });
        return toolResult({ modelText: `Stopped ${id}${result.forced ? " (it ignored the polite signal and was killed)" : ""}.` });
      },
      async web_search(args) {
        if (!webAccess) return toolResult({ ok: false, modelText: "error: web access is disabled — enable the 上網 toggle to search the web" });
        const query = String(args?.query || "").trim();
        if (!query) return toolResult({ ok: false, modelText: "error: query is required" });
        const limit = Math.min(10, Math.max(1, Number(args?.maxResults) || 5));

        const provider = String(process.env.UNIEAI_SEARCH_PROVIDER || "").trim().toLowerCase();
        const apiKey = String(process.env.UNIEAI_SEARCH_API_KEY || "").trim();
        if (!provider || !apiKey) {
          return toolResult({
            ok: false,
            modelText: "error: web search is not configured. Set UNIEAI_SEARCH_PROVIDER (brave or tavily) and UNIEAI_SEARCH_API_KEY. Until then, use fetch on a URL you already know."
          });
        }
        if (!SEARCH_PROVIDERS[provider]) {
          return toolResult({ ok: false, modelText: `error: unknown UNIEAI_SEARCH_PROVIDER "${provider}" — supported: ${Object.keys(SEARCH_PROVIDERS).join(", ")}` });
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        try {
          const results = await SEARCH_PROVIDERS[provider]({ query, limit, apiKey, signal: ctrl.signal });
          if (!results.length) return toolResult({ ok: true, modelText: `No results for "${query}".` });
          const body = results
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
            .join("\n\n");
          return toolResult({
            modelText: `${results.length} result(s) for "${query}"\n\n${truncateMiddle(body, 12_000)}`,
            metadata: { timelineEvent: { type: "web_search", query, results: results.length } }
          });
        } catch (e) {
          const msg = e?.name === "AbortError" ? "search timed out after 20s" : (e?.message || String(e));
          return toolResult({ ok: false, modelText: `error: ${msg}` });
        } finally {
          clearTimeout(timer);
        }
      },
      async ask(args, runCtx = {}) {
        const question = String(args?.question || "").trim();
        const options = (Array.isArray(args?.options) ? args.options : [])
          .map((o) => String(o || "").trim())
          .filter(Boolean);
        if (!question) return toolResult({ ok: false, modelText: "error: question is required" });
        if (options.length < 2) return toolResult({ ok: false, modelText: "error: provide at least two options" });
        if (typeof runCtx.requestQuestion !== "function") {
          // Fail closed: no host channel to ask through. Tell the model to decide.
          return toolResult({ ok: false, modelText: "error: interactive questions are unavailable here — make the best decision yourself and proceed, stating your assumption." });
        }
        const answer = await runCtx.requestQuestion({ question, options });
        const chosen = answer == null ? "" : String(answer).trim();
        if (!chosen) return toolResult({ ok: false, modelText: "The user dismissed the question without choosing. Do not ask again; proceed with a reasonable default and state your assumption." });
        return toolResult({ ok: true, modelText: `The user chose: ${chosen}` });
      }
    }
  });
}
