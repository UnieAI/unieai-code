/**
 * tools.mjs — UnieAI Code's coding toolset for the agent-core loop (productized
 * from agent-core's examples/coding-tools) — a domainToolBuilder giving agent-core a coding
 * toolset (bash / read / write / edit) where SANDBOXING AND APPROVAL ARE THE
 * TOOL'S CONCERN, not the loop's:
 *
 * - bash runs every command under the host sandbox binary
 *   (`$UNIEAI_BIN sandbox -- sh -c <cmd>`, i.e. UnieAI Code's seatbelt/landlock
 *   wrapper). On a sandbox denial it escalates through the loop-provided
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spillIfLarge, readSpilled } from "./tool-output-store.mjs";

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

const SANDBOX_DENIED = /operation not permitted|permission denied|sandbox/i;

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
function truncateMiddle(s, max = 8000) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 80) / 2);
  return `${s.slice(0, half)}\n[... output truncated (${s.length} chars total) ...]\n${s.slice(-half)}`;
}

function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
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

export function buildCodingTools({ workspace, sandboxBin = process.env.UNIEAI_BIN || "unieai", webAccess = false, allowExternal = false, externalAllowlist = [] } = {}) {
  const root = resolve(workspace || process.cwd());

  // §2.1 content-hash staleness guard: resolved abs path → SHA-1 of the exact
  // bytes the model last saw (via `read`, or the last successful write/edit).
  // A write/edit that finds a different on-disk hash refuses — the model raced
  // an external change and must re-read before mutating.
  const readHashes = new Map();

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

  // `ask` is a structured elicitation primitive, distinct from approval: it lets
  // the model put a real choice to the user (multiple options) and block on the
  // answer. The host renders it (TUI menu / VS Code card) via runCtx.requestQuestion.
  const askSchema = { type: "function", function: { name: "ask", description: "Ask the user a question with a fixed set of options when you genuinely need a decision to proceed. Blocks until they choose. Use sparingly — prefer acting when the answer is inferable.", parameters: { type: "object", properties: { question: { type: "string", description: "the question to ask" }, options: { type: "array", items: { type: "string" }, description: "2–5 concrete options" } }, required: ["question", "options"] } } };

  const schemas = [
    { type: "function", function: { name: "bash", description: "Run a shell command in the workspace (sandboxed). Prefer `rg` for searching.", parameters: { type: "object", properties: { cmd: { type: "string", description: "the command line to run" } }, required: ["cmd"] } } },
    { type: "function", function: { name: "read", description: "Read a file (workspace-relative path).", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
    { type: "function", function: { name: "write", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
    { type: "function", function: { name: "edit", description: "Edit a file by exact search/replace. oldString must appear exactly once.", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } },
    { type: "function", function: { name: "read_output", description: "Retrieve the full text of a large tool output that was spilled to storage (its preview showed an id). Optionally filter to matching lines.", parameters: { type: "object", properties: { id: { type: "string", description: "the output id from the preview marker" }, grep: { type: "string", description: "optional substring or /regex/ to filter lines" } }, required: ["id"] } } },
    askSchema,
  ];
  if (webAccess) schemas.push(fetchSchema);

  return async () => ({
    label: "coding",
    schemas,
    // `ask` blocks on the user; the loop exempts it from the tool timeout.
    interactiveTools: ["ask"],
    executors: {
      async bash(args, runCtx = {}) {
        const cmd = String(args?.cmd || "").trim();
        if (!cmd) return toolResult({ ok: false, modelText: "error: cmd is required" });
        const sandboxed = await run(sandboxBin, ["sandbox", "--", "sh", "-c", cmd], { cwd: root });
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
        const raw = await run("sh", ["-c", cmd], { cwd: root });
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
          return toolResult({ modelText: out.modelText });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async read_output(args) {
        const r = readSpilled(String(args?.id || ""), { grep: String(args?.grep || "") });
        return toolResult({ ok: r.ok, modelText: r.text });
      },
      async write(args, runCtx = {}) {
        try {
          const filePath = String(args?.filePath || "");
          const abs = resolve(root, filePath);
          const gate = await gateExternal(abs, filePath, runCtx);
          if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });
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
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async edit(args, runCtx = {}) {
        try {
          const filePath = String(args?.filePath || "");
          const abs = resolve(root, filePath);
          const gate = await gateExternal(abs, filePath, runCtx);
          if (!gate.ok) return toolResult({ ok: false, modelText: gate.message });
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
          return toolResult({ ok: res.ok, modelText: `HTTP ${res.status} ${res.statusText} · ${contentType}\n\n${truncateMiddle(text, 24_000)}` });
        } catch (e) {
          const msg = e?.name === "AbortError" ? "request timed out after 30s" : (e?.message || String(e));
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
