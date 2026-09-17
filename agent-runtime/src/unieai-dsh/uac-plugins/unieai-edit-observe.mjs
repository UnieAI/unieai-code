// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-observe.mjs — a relaxed replacement for dsh's
 * `fs-observation-policy` (disable that row and insert this one).
 *
 * dsh refuses `edit` (and `write` over an existing file) unless the file was
 * seen through its own `read` tool. Models that read with `cat`/`sed -n`/`grep`
 * hit FS_NOT_OBSERVED on every file. Here, like codex and the old agent-core:
 *
 *  - an observed file keeps the version guard: if it changed on disk since the
 *    last observation (read, write, edit, or a bash command that named it), the
 *    mutation fails with "file changed since it was read";
 *  - an unobserved file may be edited or overwritten (the edit itself still
 *    requires old_string to match the current content);
 *  - a file recorded absent that now exists (created by a command) is guarded
 *    by its current version instead of failing with "not found";
 *  - a successful bash command re-observes every existing regular file whose
 *    path appears in the command (`cat f`, `sed -n 1,80p f`, `sed -i … f`,
 *    `python f`), at its version after the command ran.
 *
 * Config: { requireReadBeforeOverwrite?: false, bashTools?: ["bash", …],
 *           maxBashPaths?: 16, prompt?: true }
 */
import { FsError } from "@deepseek-ai/dsh-fs";
import { isAbsolute, join } from "node:path";
import { policyFor, sessionCwd } from "./unieai-edit-dsh.mjs";

export const name = "unieai-edit-observe";
export const inject = ["fs"];

/** Per-owner observed state, as in fs-observation-policy. */
export class RelaxedObservationGate {
  observed = new WeakMap();

  constructor({ stat, requireReadBeforeOverwrite = false } = {}) {
    this.stat = stat;
    this.requireReadBeforeOverwrite = requireReadBeforeOverwrite;
  }

  owner(actor) {
    return actor?.agent?.session;
  }

  get(actor, target) {
    const owner = this.owner(actor);
    return owner ? this.observed.get(owner)?.get(target.targetKey) : undefined;
  }

  observe(target, observation, actor) {
    const owner = this.owner(actor);
    if (!owner) return;
    let byTarget = this.observed.get(owner);
    if (!byTarget) this.observed.set(owner, (byTarget = new Map()));
    byTarget.set(target.targetKey, observation);
  }

  clear() {
    this.observed = new WeakMap();
  }

  async writeIntent(target, actor) {
    const prior = this.get(actor, target);
    if (prior?.kind === "present") return { kind: "replaceIfVersion", version: prior.version };
    if (this.requireReadBeforeOverwrite) return { kind: "createIfAbsent" };
    return undefined; // create or overwrite
  }

  async editIntent(target, actor) {
    const prior = this.get(actor, target);
    if (prior?.kind === "present") return { version: prior.version };
    if (prior?.kind === "absent") {
      const info = await this.stat(target);
      if (!info) throw new FsError(`cannot edit "${target.displayPath}": not found`, "FS_NOT_FOUND");
      return { version: info.version };
    }
    return undefined; // unobserved: unconditional atomic edit
  }
}

const READ_LIKE = new Set([
  "cat", "head", "tail", "sed", "nl", "less", "more", "grep", "rg", "egrep", "fgrep", "awk", "wc",
  "python", "python3", "diff", "bat", "view", "vim", "vi", "nano", "cut", "sort", "uniq", "perl",
]);

/** Shell-ish words of a command: quotes honoured, operators split out. */
export function shellWords(command) {
  const words = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += command[++i]; has = true; continue; }
    if (/\s/.test(c) || "|&;<>()".includes(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
      if (!/\s/.test(c)) words.push(c);
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) words.push(cur);
  return words;
}

/**
 * Candidate file paths a command names: non-option words of every simple
 * command, plus `name=value`-free words after a read-like program. Cheap and
 * over-inclusive on purpose; callers keep only existing regular files.
 */
export function pathsInCommand(command, max = 16) {
  const out = [];
  const seen = new Set();
  for (const word of shellWords(String(command ?? ""))) {
    if (out.length >= max) break;
    if (word.length === 0 || word.length > 1024) continue;
    if ("|&;<>()".includes(word)) continue;
    if (word.startsWith("-") || word.includes("\n") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (READ_LIKE.has(word)) continue;
    // A path looks like one: has a slash or a dot-extension, no glob/expansion.
    if (/[*?$`{}\[\]]/.test(word)) continue;
    if (!/[/.]/.test(word) || /^\d+(,\d+)?p?$/.test(word)) continue;
    if (/^[a-z]+:\/\//i.test(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

const PROMPT =
  "File edits in this deployment: you do not have to open a file with the read tool before edit or write — " +
  "viewing it with shell commands (cat, sed -n, grep) is fine. If an edit or write reports that the file " +
  "changed since it was read, look at the current content again before retrying.";

export function apply(ctx, config = {}) {
  const gate = new RelaxedObservationGate({
    stat: (target) => ctx.fs.stat(target),
    requireReadBeforeOverwrite: config.requireReadBeforeOverwrite === true,
  });
  const bashTools = new Set(config.bashTools ?? ["bash", "bash_persistent"]);
  const maxBashPaths = config.maxBashPaths ?? 16;

  ctx.effect(() => () => gate.clear(), "unieai-edit-observe observed-state teardown");
  ctx.on("fs/write-intent", (target, actor) => gate.writeIntent(target, actor));
  ctx.on("fs/edit-intent", (target, actor) => gate.editIntent(target, actor));
  ctx.on("fs/observed", (target, observation, actor) => {
    gate.observe(target, observation, actor);
  });

  // bash reads count as observations. `tools/result` fires after the result
  // is final and does not alter it.
  ctx.on("tools/result", async (exec, result) => {
    if (!bashTools.has(exec.name) || result.isError || !exec.agent) return;
    if (result.value?.kind === "background") return;
    const paths = pathsInCommand(exec.arguments?.command, maxBashPaths);
    if (!paths.length) return;
    const policy = policyFor(ctx, exec);
    const workdir = exec.arguments?.workdir;
    const base = policy?.workspaceRoot ?? sessionCwd(exec);
    const cwd = workdir ? (isAbsolute(workdir) || base === undefined ? workdir : join(base, workdir)) : base;
    for (const path of paths) {
      try {
        const target = await ctx.fs.resolve(path, cwd !== undefined ? { cwd } : {});
        const info = await ctx.fs.stat(target);
        if (info?.type !== "file") continue;
        gate.observe(target, { kind: "present", version: info.version }, exec);
      } catch {
        // not a path
      }
    }
  });

  if (config.prompt !== false) {
    ctx.inject(["systemPrompt"], (promptCtx) => {
      const order = (promptCtx.systemPrompt.getSectionOrder("TOOL_EDIT") ?? 1300) + 1;
      promptCtx.systemPrompt.section({
        name: "unieai:edit-observe",
        order,
        text: ({ scope }) => (promptCtx.get("tools")?.get("edit", scope) === undefined ? "" : PROMPT),
      });
    });
  }
}
