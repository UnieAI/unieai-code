/**
 * write-policy.mjs — one decision for "may this tool write here?".
 *
 * The gap this closes: `bash` has always run inside the platform sandbox, so a
 * read-only session could not shell out a write. `write` and `edit` never went
 * near it — they checked only that the path was inside the workspace. So a
 * session the client had labelled read-only could still rewrite every file in
 * the repo, as long as the model used the file tools instead of the shell. The
 * header promised a restriction nothing enforced.
 *
 * codex settles this in one place too (`ToolOrchestrator` for the pipeline,
 * `assess_patch_safety` for patches): a write is auto-approved only when it
 * lands in a writable root, otherwise the user is asked, and some things are
 * refused outright.
 *
 * Pure: no IO, no prompting. It returns a decision and the caller does the
 * asking, so the policy can be unit-tested without a user on the other end.
 */

import { resolve, relative, isAbsolute, sep } from "node:path";

/** Sandbox modes, named as the app-server protocol names them. */
export const WRITE_MODES = ["readOnly", "workspace-write", "danger-full-access"];

/**
 * Paths inside the workspace that still deserve a question.
 *
 * `.git` is the one that matters: rewriting refs or hooks from a file tool is
 * indistinguishable from a normal edit to every guard above this one, and it can
 * rewrite history or install code that runs on the next commit. The model has no
 * legitimate reason to reach in there — the git CLI is right there.
 */
const PROTECTED_IN_WORKSPACE = [".git"];

/** True when `abs` is inside `root` (or is `root`). */
export function isInside(root, abs) {
  const rel = relative(root, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function underAny(root, abs, names) {
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const head = rel.split(sep)[0];
  return names.includes(head);
}

/**
 * @param {object} p
 * @param {string} p.workspace           the workspace root
 * @param {string} [p.mode]              readOnly | workspace-write | danger-full-access
 * @param {string[]} [p.writableRoots]   extra absolute paths writes may land in
 * @param {boolean} [p.allowExternal]    host opt-out of the workspace boundary
 * @param {string[]} [p.externalAllowlist] pre-approved paths outside the workspace
 */
export function createWritePolicy({
  workspace,
  mode = "workspace-write",
  writableRoots = [],
  allowExternal = false,
  externalAllowlist = [],
} = {}) {
  const root = resolve(workspace || process.cwd());
  const extra = (Array.isArray(writableRoots) ? writableRoots : []).map((p) => resolve(root, p));
  // Grows as the user approves paths "for this session" — the same reason codex
  // caches approvals per key: a retry of an approved write must not re-prompt.
  const approved = new Set((Array.isArray(externalAllowlist) ? externalAllowlist : []).map((p) => resolve(root, p)));

  /**
   * @returns {{decision:"allow"|"ask", kind?:string, reason?:string}}
   *
   * There is no "reject": every refusal here is one the user could legitimately
   * override, and a policy that cannot be overridden is a policy the user works
   * around by leaving the sandbox entirely.
   */
  function assess(target) {
    const abs = resolve(root, String(target ?? ""));
    if (mode === "danger-full-access") return { decision: "allow" };
    if (approved.has(abs)) return { decision: "allow" };
    if (extra.some((r) => isInside(r, abs))) return { decision: "allow" };

    if (!isInside(root, abs)) {
      if (allowExternal) return { decision: "allow" };
      return {
        decision: "ask",
        kind: "external_directory",
        reason: `it resolves outside the workspace root (${root})`,
      };
    }
    if (mode === "readOnly") {
      return { decision: "ask", kind: "read_only_write", reason: "this session is read-only" };
    }
    if (underAny(root, abs, PROTECTED_IN_WORKSPACE)) {
      return {
        decision: "ask",
        kind: "protected_path",
        reason: "writing into .git can rewrite history or install code that runs on the next commit",
      };
    }
    return { decision: "allow" };
  }

  /** Remember a path the user approved for the rest of the session. */
  function remember(target) {
    approved.add(resolve(root, String(target ?? "")));
  }

  return { assess, remember, get mode() { return mode; }, root };
}
