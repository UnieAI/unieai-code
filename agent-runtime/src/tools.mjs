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
import { toolResult } from "../../third_party/unieai-agent-core/src/tools/_util.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
    const err = String(e.stderr || e.message || "").slice(-500);
    notes.push(`⚠ file no longer compiles:\n${err}\nFix this before anything else.`);
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

export function buildCodingTools({ workspace, sandboxBin = process.env.UNIEAI_BIN || "unieai", webAccess = false } = {}) {
  const root = resolve(workspace || process.cwd());
  const inWorkspace = (p) => {
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + "/")) throw new Error(`path escapes workspace: ${p}`);
    return abs;
  };

  // fetch is an OPTIONAL domain tool gated by the consumer's web-access toggle;
  // the loop stays unaware of it. Off by default so a plain coding session has
  // no network reach beyond what bash's sandbox already governs.
  const fetchSchema = { type: "function", function: { name: "fetch", description: "Fetch an http(s) URL and return its content as readable text (HTML is reduced to text). Use to read documentation pages or HTTP APIs the task references.", parameters: { type: "object", properties: { url: { type: "string", description: "absolute http(s) URL" } }, required: ["url"] } } };

  const schemas = [
    { type: "function", function: { name: "bash", description: "Run a shell command in the workspace (sandboxed). Prefer `rg` for searching.", parameters: { type: "object", properties: { cmd: { type: "string", description: "the command line to run" } }, required: ["cmd"] } } },
    { type: "function", function: { name: "read", description: "Read a file (workspace-relative path).", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
    { type: "function", function: { name: "write", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
    { type: "function", function: { name: "edit", description: "Edit a file by exact search/replace. oldString must appear exactly once.", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } },
  ];
  if (webAccess) schemas.push(fetchSchema);

  return async () => ({
    label: "coding",
    schemas,
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
          return toolResult({ ok: sandboxed.code === 0, modelText: `exit ${sandboxed.code}\n${truncateMiddle(sandboxed.stdout + sandboxed.stderr)}` });
        }
        // Sandbox denial → escalate through the host's approval channel.
        const decision = runCtx.requestApproval
          ? await runCtx.requestApproval({ tool: "bash", action: "run outside the sandbox", detail: cmd })
          : "decline";
        if (decision !== "accept" && decision !== "acceptForSession") {
          return toolResult({ ok: false, modelText: `exit ${sandboxed.code}\n(blocked by sandbox; escalation ${runCtx.requestApproval ? "declined by user" : "unavailable"})\n${sandboxed.stderr.slice(0, 2000)}` });
        }
        const raw = await run("sh", ["-c", cmd], { cwd: root });
        return toolResult({ ok: raw.code === 0, modelText: `exit ${raw.code} (approved, unsandboxed)\n${truncateMiddle(raw.stdout + raw.stderr)}` });
      },
      async read(args) {
        try {
          const body = await readFile(inWorkspace(String(args?.filePath || "")), "utf8");
          return toolResult({ modelText: body.slice(0, 32_000) });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async write(args) {
        try {
          const abs = inWorkspace(String(args?.filePath || ""));
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, String(args?.content ?? ""), "utf8");
          return toolResult({ modelText: `wrote ${args.filePath}${pyInstantChecks(abs)}` });
        } catch (e) { return toolResult({ ok: false, modelText: `error: ${e.message}` }); }
      },
      async edit(args) {
        try {
          const abs = inWorkspace(String(args?.filePath || ""));
          const before = await readFile(abs, "utf8");
          const oldString = String(args?.oldString ?? "");
          const newString = String(args?.newString ?? "");
          // Fast path: exact substring, must be unique.
          const hits = before.split(oldString).length - 1;
          if (hits === 1) {
            const after = before.replace(oldString, newString);
            await writeFile(abs, after, "utf8");
            return toolResult({ modelText: `edited ${args.filePath}${pyInstantChecks(abs, { oldString, fileBody: after })}` });
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
          const joined = fileLines.join("\n");
          await writeFile(abs, joined, "utf8");
          const note = found.tier === "exact" ? "" : ` (matched ${found.tier})`;
          return toolResult({ modelText: `edited ${args.filePath}${note}${pyInstantChecks(abs, { oldString, fileBody: joined })}` });
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
      }
    }
  });
}
