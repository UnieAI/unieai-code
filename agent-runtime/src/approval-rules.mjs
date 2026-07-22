/**
 * approval-rules.mjs — remember bash approvals so the same command shape isn't
 * re-asked (idea from opencode's saved permissions + bash arity reduction).
 *
 * `acceptForSession` currently has no teeth: nothing records it, so `git log`
 * is re-approved every time. This normalizes a command to a stable SIGNATURE
 * (command + subcommand, flags/args dropped) so `git log -n5 --oneline` and
 * `git log` share one rule, and keeps two scopes: a session set (matches the
 * "allow for this conversation" button) and a durable per-project store (ready
 * for an explicit "always" — the mechanism is here even though no frontend
 * surfaces that decision yet).
 *
 * Signature is deliberately conservative: only the command name (+ subcommand
 * for known multi-command tools) is kept, so a saved `git log` never
 * accidentally auto-approves `git push`. Pure signature logic; the store does
 * best-effort disk IO under UNIEAI_HOME.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

// Tools whose FIRST argument is a subcommand that changes what the command does
// (so the signature must include it: `git log` ≠ `git push`).
const SUBCOMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl",
  "pip", "pip3", "poetry", "uv", "brew", "apt", "apt-get", "gh", "make",
  "systemctl", "terraform", "gcloud", "aws", "deno", "rustup",
]);

// Commands whose danger lives in their ARGUMENTS, so a bare-name signature is
// meaningless as a safety boundary: approving `rm tmp/x` must never
// auto-approve `rm -rf ~`. These never produce a signature — every invocation
// is approved individually. (These approvals gate the UNSANDBOXED rerun after
// a sandbox denial, so the stakes are real.)
const NEVER_REMEMBER = new Set([
  "rm", "rmdir", "unlink", "shred", "srm",
  "mv", "cp", "dd", "truncate", "ln",
  "chmod", "chown", "chgrp", "chflags",
  "find", "xargs", "rsync",
  "kill", "killall", "pkill",
  "mkfs", "diskutil", "fdisk", "launchctl", "shutdown", "reboot",
  "sudo", "su", "doas", "env", "nice", "nohup", "time", "command", "exec", "eval", "sh", "bash", "zsh",
]);

/**
 * Normalize a shell command to an approval signature. Returns "" for an empty or
 * unparseable command (which never matches a saved rule).
 */
export function ruleSignature(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return "";
  // A command with a shell operator is not a single call — don't reduce it to a
  // signature (it could smuggle a second command past the rule).
  if (/[;&|><`$(){}]|\n/.test(cmd)) return "";
  const tokens = cmd.split(/\s+/);
  const isFlag = (t) => t.startsWith("-");
  const name = tokens.find((t) => !isFlag(t));
  if (!name) return "";
  if (NEVER_REMEMBER.has(name)) return ""; // argument-dangerous: approve each invocation
  if (!SUBCOMMAND_TOOLS.has(name)) return name;
  // Keep the first non-flag token after the command as the subcommand.
  const rest = tokens.slice(tokens.indexOf(name) + 1).filter((t) => !isFlag(t));
  return rest.length ? `${name} ${rest[0]}` : name;
}

function approvalsDir() {
  const dir = join(unieaiHome(), "approvals");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function projectFile(projectKey) {
  const key = String(projectKey || "default").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "default";
  return join(approvalsDir(), `${key}.json`);
}

/** Load the durable set of approved signatures for a project. Never throws. */
export function loadApprovals(projectKey) {
  try {
    const arr = JSON.parse(readFileSync(projectFile(projectKey), "utf8"));
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

/** Persist a signature durably for a project. Best-effort; returns true on write. */
export function saveApproval(projectKey, signature) {
  const sig = String(signature || "").trim();
  if (!sig) return false;
  try {
    const set = loadApprovals(projectKey);
    if (set.has(sig)) return true;
    set.add(sig);
    writeFileSync(projectFile(projectKey), JSON.stringify([...set]), "utf8");
    return true;
  } catch {
    return false;
  }
}
