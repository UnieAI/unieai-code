// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-rewind.mjs — rewinding the conversation can rewind the files too.
 *
 * Going back to an earlier message (Esc Esc in UnieAI Code) only trimmed the
 * conversation; whatever the model had changed in the workspace stayed. This
 * plugin keeps workspace checkpoints so the client can offer "restore code and
 * conversation" next to "conversation only".
 *
 * Checkpoints are git trees in a SHADOW repository under the dsh home
 * (`$DSH_HOME/unieai-rewind/<workspace hash>/`), with the workspace as its
 * work tree and a private index per process. The user's own `.git`, index,
 * refs and files are never written; the workspace's `.gitignore` files are
 * honoured, and a few dependency/cache directories are always left out.
 * Because a snapshot is the whole work tree, edits made by exec_command and
 * every other shell are covered, not only apply_patch and the edit tools.
 *
 * - A top-level turn is snapshotted before its first tool that may change
 *   files (anything outside {@link READ_ONLY_TOOLS}; subagents are started by
 *   a tool of their parent, so their edits fall inside its turn), and again
 *   when it ends. A chat-only turn costs nothing.
 * - A turn is named by its `turn/start` event (time and dsh turn number), which
 *   a forked session keeps, so checkpoints stay valid after a revert.
 * - `preview` / `restore` (the `unieaiRewind` service, called by the host's
 *   control plugin) take the session's events and the first event to undo.
 *   Only paths the undone turns changed are put back — a file the user edited
 *   that no undone turn touched stays as it is — to their content before the
 *   first undone turn that snapshotted. Restoring first snapshots the current
 *   state as an undo point (`refs/unieai-rewind/undo-*`).
 *
 * Bounds: at most `maxTurns` turns per workspace (older ones are dropped and
 * their objects pruned), a workspace store unused for `retainDays` is removed,
 * untracked files larger than `maxFileBytes` are not snapshotted, and a
 * workspace whose first snapshot would take more than `maxNewFiles` new files
 * (or the home directory, or `/`) is not snapshotted at all.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const name = "unieai-rewind";

/** The service the host's control plugin calls. */
export const SERVICE = "unieaiRewind";

export const DEFAULTS = Object.freeze({
  maxTurns: 100,
  retainDays: 30,
  maxNewFiles: 50000,
  maxFileBytes: 10 * 1024 * 1024,
  timeoutMs: 60000,
});

/** Tools that never change files: no snapshot is taken for them. */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "view_image",
  "describe_image",
  "web_fetch",
  "web_search",
  "todo_write",
  "todo_read",
  "skill",
  "ask_user",
  "wait_agents",
  "session_query",
]);

/** Always left out of snapshots, on top of the workspace's own ignore rules. */
export const ALWAYS_EXCLUDED = Object.freeze([
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".tox/",
  ".gradle/",
  ".next/",
  ".cache/",
  "target/",
]);

const REF_PREFIX = "refs/unieai-rewind/";

/** The identity of a turn: its `turn/start` time and number, which forks keep. */
export function turnKey(event) {
  return `${event.time ?? 0}:${event.data?.turn ?? 0}`;
}

/** Keys of the turns that start at or after `fromSeq`, in order. */
export function turnKeysFrom(events, fromSeq) {
  return (events ?? []).filter((event) => event?.type === "turn/start" && event.seq >= fromSeq).map(turnKey);
}

/** The directory a session's turns are snapshotted in, or null for none. */
export function workspaceOf(header) {
  if (!header || header.origin === "subagent" || (header.delegationDepth ?? 0) > 0) return null;
  const cwd = typeof header.cwd === "string" && header.cwd ? resolve(header.cwd) : null;
  if (!cwd || cwd === sep || cwd === resolve(homedir())) return null;
  return cwd;
}

/** A gitignore line matching exactly one path from the work-tree root. */
export function ignoreLine(path) {
  return `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "))}`;
}

/** NUL-separated `git diff-tree --name-status -z` output -> [{status, path}]. */
export function parseNameStatus(output) {
  const parts = output.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) break;
    out.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return out;
}

const CHANGE_OF_STATUS = { A: "delete", D: "create" };

/**
 * One workspace's shadow repository. Every git operation goes through one
 * queue, so a snapshot never races another snapshot or a restore.
 */
export class ShadowStore {
  constructor({ root, cwd, limits = DEFAULTS, logger = console, git = "git" }) {
    this.cwd = cwd;
    this.root = resolve(root);
    this.dir = join(root, createHash("sha1").update(cwd).digest("hex").slice(0, 16));
    this.gitDir = join(this.dir, "git");
    this.logPath = join(this.dir, "checkpoints.jsonl");
    // A private index per process: two hosts on one workspace never fight
    // over the index lock, and the stat cache keeps later snapshots cheap.
    this.indexPath = join(this.dir, `index-${process.pid}-${randomUUID().slice(0, 8)}`);
    this.limits = limits;
    this.logger = logger;
    this.gitBin = git;
    this.chain = Promise.resolve();
    this.ready = null;
    this.disabled = null;
  }

  queue(work) {
    const run = this.chain.then(work);
    this.chain = run.catch(() => {});
    return run;
  }

  git(args, { buffer = false, okCodes = [0] } = {}) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
    Object.assign(env, {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.cwd,
      GIT_INDEX_FILE: this.indexPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
    });
    return new Promise((resolvePromise, reject) => {
      execFile(
        this.gitBin,
        args,
        { cwd: this.cwd, env, encoding: buffer ? "buffer" : "utf8", maxBuffer: 256 * 1024 * 1024, timeout: this.limits.timeoutMs },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          if (okCodes.includes(code)) resolvePromise(stdout);
          else reject(new Error(`git ${args[0]} failed (${code}): ${String(stderr || error?.message || "").trim().slice(0, 400)}`));
        },
      );
    });
  }

  init() {
    this.ready ??= (async () => {
      await mkdir(this.gitDir, { recursive: true });
      await this.git(["init", "-q"]);
      for (const [key, value] of [
        ["core.autocrlf", "false"],
        ["core.safecrlf", "false"],
        ["core.symlinks", "true"],
        ["gc.auto", "0"],
        ["advice.addEmbeddedRepo", "false"],
      ]) {
        await this.git(["config", key, value]);
      }
      await mkdir(join(this.gitDir, "info"), { recursive: true });
      const excluded = [...ALWAYS_EXCLUDED];
      // A workspace that holds the store itself does not snapshot it.
      if (this.root.startsWith(this.cwd + sep)) excluded.push(`${ignoreLine(this.root.slice(this.cwd.length + 1).split(sep).join("/"))}/`);
      await writeFile(join(this.gitDir, "info", "exclude"), `${excluded.join("\n")}\n`);
      await writeFile(join(this.dir, "workspace"), `${this.cwd}\n`);
      await this.dropStaleIndexes();
    })();
    return this.ready;
  }

  async dropStaleIndexes() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const entry of await readdir(this.dir).catch(() => [])) {
      if (!entry.startsWith("index-")) continue;
      const path = join(this.dir, entry);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff && path !== this.indexPath) await rm(path, { force: true });
    }
  }

  /** Write the work tree as a tree object (inside the queue). */
  async snapshot() {
    if (this.disabled) throw new Error(this.disabled);
    await this.init();
    try {
      return await this.writeTree();
    } catch (error) {
      // A prune by another process can drop blobs only our index still
      // names; start the index afresh once.
      await rm(this.indexPath, { force: true });
      return this.writeTree().catch(() => {
        throw error;
      });
    }
  }

  async writeTree() {
    const fresh = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = fresh.split("\0").filter(Boolean);
    if (paths.length > this.limits.maxNewFiles) {
      this.disabled = `${paths.length} new files (more than ${this.limits.maxNewFiles}); add a .gitignore to enable rewinding files`;
      throw new Error(this.disabled);
    }
    const large = [];
    for (const path of paths) {
      const info = await lstat(join(this.cwd, path)).catch(() => null);
      if (info?.isFile() && info.size > this.limits.maxFileBytes) large.push(path);
    }
    if (large.length > 0) {
      await appendFile(join(this.gitDir, "info", "exclude"), `${large.map(ignoreLine).join("\n")}\n`);
    }
    // Exit 1 is an unreadable file skipped by --ignore-errors; the rest is written.
    await this.git(["add", "--all", "--ignore-errors", "--", "."], { okCodes: [0, 1] });
    return (await this.git(["write-tree"])).trim();
  }

  async records() {
    const text = await readFile(this.logPath, "utf8").catch(() => "");
    const byKey = new Map();
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record?.key || !record?.tree) continue;
      const turn = byKey.get(record.key) ?? { key: record.key, at: record.at };
      // The first start of a turn wins; the last end does.
      if (record.kind === "start") turn.start ??= record.tree;
      else if (record.kind === "end") turn.end = record.tree;
      byKey.set(record.key, turn);
    }
    return byKey;
  }

  refName(key, kind) {
    return `${REF_PREFIX}${key.replace(/[^0-9A-Za-z_-]/g, "_")}-${kind}`;
  }

  /** Snapshot now and record it as `kind` of turn `key`. */
  checkpoint(key, kind) {
    return this.queue(async () => {
      const tree = await this.snapshot();
      await this.git(["update-ref", this.refName(key, kind), tree]);
      await appendFile(this.logPath, `${JSON.stringify({ key, kind, tree, at: Date.now() })}\n`);
      if (kind === "start") await this.prune();
      return tree;
    });
  }

  /** Keep the newest `maxTurns` turns; drop the rest and their objects. */
  async prune() {
    const turns = [...(await this.records()).values()];
    if (turns.length <= Math.ceil(this.limits.maxTurns * 1.2)) return;
    turns.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const keep = new Set(turns.slice(-this.limits.maxTurns).map((turn) => turn.key));
    const text = await readFile(this.logPath, "utf8").catch(() => "");
    const kept = text.split("\n").filter((line) => {
      try {
        return keep.has(JSON.parse(line).key);
      } catch {
        return false;
      }
    });
    const tmp = `${this.logPath}.${process.pid}.tmp`;
    await writeFile(tmp, kept.map((line) => `${line}\n`).join(""));
    await rename(tmp, this.logPath);
    const keepRefs = new Set([...keep].flatMap((key) => ["start", "end"].map((kind) => this.refName(key, kind))));
    const refs = (await this.git(["for-each-ref", "--format=%(refname)", REF_PREFIX])).split("\n").filter(Boolean);
    const stale = refs.filter((ref) => !keepRefs.has(ref) && !ref.startsWith(`${REF_PREFIX}undo-`));
    // Undo points are kept for the newest ten restores only.
    const undos = refs.filter((ref) => ref.startsWith(`${REF_PREFIX}undo-`)).sort();
    stale.push(...undos.slice(0, Math.max(0, undos.length - 10)));
    for (const ref of stale) await this.git(["update-ref", "-d", ref]);
    // Not "now": another process may be writing objects it has not named yet.
    await this.git(["gc", "--quiet", "--prune=1.day.ago"]);
    this.logger.info?.(`${name}: pruned ${turns.length - keep.size} old turn(s) in ${this.cwd}`);
  }

  /** What restoring before the turns `keys` would change (inside the queue). */
  async plan(keys) {
    const records = await this.records();
    const turns = keys.map((key) => records.get(key)).filter((turn) => turn?.start);
    if (turns.length === 0) return { target: null, current: null, files: [] };
    const current = await this.snapshot();
    const touched = new Set();
    for (const turn of turns) {
      const changed = await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", turn.start, turn.end ?? current]);
      for (const { path } of parseNameStatus(changed)) touched.add(path);
    }
    const target = turns[0].start;
    const differences = parseNameStatus(await this.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", target, current]));
    const files = differences
      .filter(({ path }) => touched.has(path))
      .map(({ status, path }) => ({ path, change: CHANGE_OF_STATUS[status] ?? "modify" }));
    return { target, current, files };
  }

  preview(keys) {
    if (this.disabled) return Promise.resolve({ available: false, reason: this.disabled, files: [] });
    return this.queue(async () => {
      const { files } = await this.plan(keys);
      return { available: true, files };
    });
  }

  restore(keys) {
    return this.queue(async () => {
      const { target, current, files } = await this.plan(keys);
      if (!target || files.length === 0) return { files: [], failed: [], undo: null };
      const undoRef = `${REF_PREFIX}undo-${Date.now()}`;
      await this.git(["update-ref", undoRef, current]);
      const failed = [];
      // Deletions first: a file can come back where a directory was created.
      const ordered = [...files.filter((file) => file.change === "delete"), ...files.filter((file) => file.change !== "delete")];
      for (const file of ordered) {
        try {
          if (file.change === "delete") await this.removeFile(file.path, target);
          else await this.writeFromTree(file.path, target);
        } catch (error) {
          failed.push({ path: file.path, error: String(error?.message ?? error) });
        }
      }
      this.logger.info?.(`${name}: restored ${files.length - failed.length}/${files.length} file(s) in ${this.cwd}; undo point ${undoRef}`);
      return { files, failed, undo: undoRef };
    });
  }

  absolute(path) {
    const abs = resolve(this.cwd, path);
    if (!abs.startsWith(this.cwd + sep)) throw new Error("outside the workspace");
    return abs;
  }

  async removeFile(path, target) {
    const abs = this.absolute(path);
    await unlink(abs).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    // Directories left empty go too, unless the target has them.
    for (let dir = dirname(abs); dir.startsWith(this.cwd + sep); dir = dirname(dir)) {
      const relative = dir.slice(this.cwd.length + 1).split(sep).join("/");
      const inTarget = await this.git(["cat-file", "-e", `${target}:${relative}`]).then(
        () => true,
        () => false,
      );
      if (inTarget) break;
      if (!(await rmdir(dir).then(() => true, () => false))) break;
    }
  }

  async writeFromTree(path, target) {
    const abs = this.absolute(path);
    const entry = (await this.git(["ls-tree", "-z", target, "--", path])).split("\0")[0];
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(entry);
    if (!match) throw new Error("not in the checkpoint");
    const [, mode, type, object] = match;
    if (type !== "blob") throw new Error("a nested repository is not restored");
    const content = await this.git(["cat-file", "blob", object], { buffer: true });
    const existing = await lstat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new Error("a directory is in the way");
    await mkdir(dirname(abs), { recursive: true });
    if (mode === "120000") {
      if (existing) await unlink(abs);
      await symlink(content.toString(), abs);
      return;
    }
    // Never write through a symlink that now stands where the file was.
    if (existing?.isSymbolicLink()) await unlink(abs);
    const executable = mode === "100755";
    if (existing?.isFile()) {
      await writeFile(abs, content);
      const bits = existing.mode & 0o777;
      const wanted = executable ? bits | ((bits & 0o444) >> 2) : bits & ~0o111;
      if (wanted !== bits) await chmod(abs, wanted);
    } else {
      await writeFile(abs, content, { mode: executable ? 0o755 : 0o644 });
    }
  }
}

/** Remove workspace stores not used for `retainDays`. */
export async function pruneStores(root, retainDays, logger = console) {
  const cutoff = Date.now() - retainDays * 24 * 3600 * 1000;
  for (const entry of await readdir(root).catch(() => [])) {
    const dir = join(root, entry);
    const info = (await stat(join(dir, "checkpoints.jsonl")).catch(() => null)) ?? (await stat(dir).catch(() => null));
    if (info && info.mtimeMs < cutoff) {
      await rm(dir, { recursive: true, force: true });
      logger.info?.(`${name}: removed the unused store ${entry}`);
    }
  }
}

const positive = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback);

export function apply(ctx, rawConfig = {}) {
  const limits = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, positive(rawConfig[key], value)]));
  const root = rawConfig.dir || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "unieai-rewind");
  const stores = new Map();
  const storeFor = (cwd) => {
    let store = stores.get(cwd);
    if (!store) {
      store = new ShadowStore({ root, cwd, limits, logger: ctx.logger });
      stores.set(cwd, store);
    }
    return store;
  };
  /** session -> the open top-level turn: { key, store, started } */
  const turns = new WeakMap();

  pruneStores(root, limits.retainDays, ctx.logger).catch(() => {});
  ctx.effect?.(() => () => {
    for (const store of stores.values()) rm(store.indexPath, { force: true }).catch(() => {});
  });

  ctx.on("session/event", (session, event) => {
    if (event?.type === "turn/start") {
      const cwd = workspaceOf(session.header);
      if (cwd) turns.set(session, { key: turnKey(event), turn: event.data?.turn, store: storeFor(cwd), started: null });
      return;
    }
    if (event?.type !== "turn/end") return;
    const open = turns.get(session);
    if (!open || open.turn !== event.data?.turn) return;
    turns.delete(session);
    if (!open.started) return;
    open.started
      .then(
        () => open.store.checkpoint(open.key, "end"),
        () => null, // the start already failed and was reported
      )
      .catch((error) => ctx.logger.warn(`${name}: no end checkpoint for turn ${open.key}: ${error?.message ?? error}`));
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    const session = exec?.parent === undefined ? exec?.agent?.session : undefined;
    const open = session ? turns.get(session) : undefined;
    if (open && !READ_ONLY_TOOLS.has(exec.name)) {
      open.started ??= open.store.checkpoint(open.key, "start");
      try {
        await open.started;
      } catch (error) {
        if (!open.warned) ctx.logger.warn(`${name}: turn ${open.key} is not snapshotted: ${error?.message ?? error}`);
        open.warned = true;
      }
    }
    return next();
  });

  const target = ({ cwd, events, fromSeq }) => {
    const workspace = workspaceOf({ cwd });
    return workspace ? { store: storeFor(workspace), keys: turnKeysFrom(events, fromSeq) } : null;
  };

  ctx.provide?.(SERVICE, {
    /** The files restoring before `fromSeq` would change: { available, files: [{path, change}] }. */
    async preview(request) {
      const found = target(request);
      if (!found) return { available: false, reason: "this workspace is not snapshotted", files: [] };
      return found.store.preview(found.keys);
    },
    /** Put those files back: { files, failed: [{path, error}], undo }. */
    async restore(request) {
      const found = target(request);
      if (!found) return { files: [], failed: [], undo: null };
      return found.store.restore(found.keys);
    },
  });
}
