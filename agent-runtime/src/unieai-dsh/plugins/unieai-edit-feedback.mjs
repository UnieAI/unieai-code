// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-feedback.mjs — tell the model what its edit actually did.
 *
 * dsh's `edit`/`write` answer "The file … has been updated successfully." and
 * keep the diff for the UI only. After a successful edit, write or
 * apply_patch this plugin appends, to the text the model sees:
 *  - a compact unified diff of each changed file (capped), so the model can
 *    check the change without reading the file again;
 *  - for `.py` files, a syntax check: the new text is compiled by `python3`
 *    (`compile(src, path, "exec")`, the check `py_compile` performs, fed on
 *    stdin so no `__pycache__` is written). A failure that the file already
 *    had before the change is labelled as pre-existing.
 *
 * The check runs through dsh's shell service when mounted (session workdir,
 * sandbox policy, the session's python), else as a host subprocess.
 *
 * Config: { tools?: ["edit","write","apply_patch","str_replace_editor"],
 *           maxDiffLines?: 60, context?: 3, python?: "python3",
 *           syntaxCheck?: true, timeoutMs?: 10000, diffOnWriteCreate?: false }
 */
import { execFile } from "node:child_process";
import { unifiedDiff } from "./unieai-edit-match.mjs";
import { appendOnPostExecute, policyFor, sessionCwd } from "./unieai-edit-dsh.mjs";

export const name = "unieai-edit-feedback";
export const inject = ["tools"];

const COMPILE = "import sys; src = sys.stdin.buffer.read(); compile(src, sys.argv[1], 'exec')";

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Files changed by a successful result: [{path, before, after, created}] */
export function changedFiles(toolName, value, args = {}) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.files)) {
    return value.files
      .filter((f) => f.kind !== "delete")
      .map((f) => ({ path: f.movePath ?? f.path, before: f.before, after: f.after, created: f.kind === "add" && f.before === null }));
  }
  if (typeof value.after === "string" && typeof value.path === "string") {
    const created = value.operation ? value.operation === "create" : value.before === null || value.before === undefined;
    return [{ path: value.path, before: value.before ?? null, after: value.after, created }];
  }
  // str_replace_editor has no before/after in its value; nothing to diff.
  void toolName;
  void args;
  return [];
}

/** The last lines of a python traceback: location, caret, `SyntaxError: …`. */
export function lastErrorLines(stderr, max = 6) {
  const lines = String(stderr ?? "")
    .trimEnd()
    .split("\n")
    // Drop the wrapper's own frames: `Traceback …` and `File "<string>"`.
    .filter((l) => !/^Traceback \(most recent call last\):$/.test(l) && !/^\s*File "<string>"/.test(l));
  const tail = lines.slice(-max);
  return tail.join("\n");
}

function runHost(python, path, source, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(python, ["-c", COMPILE, path], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true });
      if (error.code === "ENOENT" || error.killed || error.signal) return resolve({ ok: null });
      resolve({ ok: false, stderr: String(stderr) });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(source);
  });
}

async function runShell(ctx, exec, python, path, source, timeoutMs) {
  const shell = ctx.get("shell");
  const policy = policyFor(ctx, exec);
  const workdir = policy?.workspaceRoot ?? sessionCwd(exec);
  const spec = shell.resolve({
    command: `${python} -c ${shellQuote(COMPILE)} ${shellQuote(path)}`,
    ...(workdir !== undefined ? { workdir } : {}),
    timeoutMs,
    stdin: source,
    signal: exec.signal,
    ...(policy !== undefined ? { sandboxPolicy: { ...policy, mode: policy.mode === "danger-full-access" ? policy.mode : "read-only" } } : {}),
  });
  const result = await shell.run(spec);
  if (result.exitCode === 0) return { ok: true };
  if (result.timedOut || result.aborted || result.exitCode === 127 || result.exitCode === null || result.sandbox?.runnerFailed) {
    return { ok: null, detail: { exitCode: result.exitCode, timedOut: result.timedOut, sandbox: result.sandbox, stderr: result.stderr?.text?.slice(-300) } };
  }
  const stderr = result.stderr?.text ?? "";
  // Only a real compile failure counts; anything else (no python, sandbox) is silent.
  if (!/Error/.test(stderr) || /command not found|No such file or directory: '?python/.test(stderr)) return { ok: null, detail: { exitCode: result.exitCode, stderr: stderr.slice(-300) } };
  return { ok: false, stderr };
}

export function apply(ctx, config = {}) {
  const tools = new Set(config.tools ?? ["edit", "write", "apply_patch", "str_replace_editor"]);
  const maxDiffLines = config.maxDiffLines ?? 60;
  const context = config.context ?? 3;
  const python = config.python ?? "python3";
  const timeoutMs = config.timeoutMs ?? 10_000;
  const syntaxCheck = config.syntaxCheck !== false;

  const check = async (exec, path, source) => {
    let outcome;
    try {
      outcome = ctx.get("shell")
        ? await runShell(ctx, exec, python, path, source, timeoutMs)
        : await runHost(python, path, source, timeoutMs);
    } catch (error) {
      outcome = { ok: null, error: error?.message ?? String(error) };
    }
    return outcome;
  };

  appendOnPostExecute(ctx, async (exec, result) => {
    if (!tools.has(exec.name) || result.isError || exec.signal?.aborted) return undefined;
    const files = changedFiles(exec.name, result.value, exec.arguments);
    if (!files.length) return undefined;
    const parts = [];
    let budget = maxDiffLines;
    for (const f of files) {
      if (!f.created && f.before === null) {
        parts.push(`${f.path}: overwritten (too large to diff).`);
      } else if (f.created && !config.diffOnWriteCreate) {
        const n = f.after === "" ? 0 : f.after.replace(/\n$/, "").split("\n").length;
        parts.push(`${f.path}: new file, ${n} line${n === 1 ? "" : "s"}.`);
      } else if (budget > 0) {
        const d = unifiedDiff(f.before ?? "", f.after, { context, maxLines: budget });
        if (!d.text) parts.push(`${f.path}: content unchanged.`);
        else {
          parts.push(`Diff of ${f.path} (+${d.added} -${d.removed}):\n${d.text}`);
          budget -= d.text.split("\n").length;
        }
      } else {
        parts.push(`${f.path}: changed (diff omitted).`);
      }
      if (syntaxCheck && /\.py$/.test(f.path)) {
        const now = await check(exec, f.path, f.after);
        if (now.ok === true) parts.push(`Syntax check (python compile) of ${f.path}: OK.`);
        else if (now.ok === false) {
          const had = f.before ? await check(exec, f.path, f.before) : { ok: true };
          const label = had.ok === false ? "still fails (the file already failed before this change)" : "FAILED — this change broke the file";
          parts.push(`Syntax check (python compile) of ${f.path}: ${label}:\n${lastErrorLines(now.stderr)}`);
        }
      }
    }
    return parts.length ? `\n${parts.join("\n")}` : undefined;
  });
}
