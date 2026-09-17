// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-testkit.mjs — a minimal stand-in for the dsh plugin context
 * (events + a disk-backed `ctx.fs`) used by the unieai-edit-* and
 * unieai-apply-patch unit tests. Not loaded by dsh.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";

const created = [];
process.once("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

export function tempWorkspace(prefix = "unieai-edit-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** A disk-backed fs with dsh-fs-local's guard semantics (no locking). */
export function fakeFs(root) {
  const probe = (p) => {
    try {
      const s = statSync(p);
      return { version: `${s.mtimeMs}:${s.size}:${s.ino}`, type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other" };
    } catch {
      return undefined;
    }
  };
  let tick = 0;
  // Distinct versions per write: nudge mtime forward.
  const write = (p, content) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    const when = new Date(statSync(p).mtimeMs + 1000 * ++tick);
    utimesSync(p, when, when);
  };
  const fs = {
    sandboxMode: undefined,
    calls: [],
    async resolve(path, opts = {}) {
      const abs = isAbsolute(path) ? path : resolve(opts.cwd ?? root, path);
      return { targetKey: abs, displayPath: abs };
    },
    processPath: (t) => String(t.targetKey),
    processPathFromHostPath: (p) => (isAbsolute(p) ? resolve(p) : undefined),
    async stat(t) {
      return probe(t.targetKey);
    },
    async readText(t) {
      if (!probe(t.targetKey)) throw new FsError(`not found "${t.displayPath}"`, "FS_NOT_FOUND");
      return readFileSync(t.targetKey, "utf8");
    },
    async writeText(t, content, expected) {
      fs.calls.push(["writeText", t.targetKey]);
      const existing = probe(t.targetKey);
      if (expected?.kind === "replaceIfVersion") {
        if (!existing || existing.version !== expected.version) throw new FsError(`cannot write "${t.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
      } else if (expected?.kind === "createIfAbsent" && existing) {
        throw new FsError(`cannot overwrite existing "${t.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
      }
      if (fs.failWrite?.(t.targetKey)) throw new FsError(`disk full "${t.displayPath}"`, "FS_IO_ERROR");
      const before = existing ? readFileSync(t.targetKey, "utf8").replace(/\r\n/g, "\n") : null;
      write(t.targetKey, content);
      return { operation: existing ? "update" : "create", version: probe(t.targetKey).version, before, after: content.replace(/\r\n/g, "\n") };
    },
    async editText(t, edit, expected) {
      fs.calls.push(["editText", t.targetKey]);
      const existing = probe(t.targetKey);
      if (!existing) throw new FsError(`cannot edit "${t.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
      if (expected && existing.version !== expected.version) throw new FsError(`cannot edit "${t.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
      const raw = readFileSync(t.targetKey, "utf8");
      const crlf = raw.includes("\r\n");
      const content = raw.replace(/\r\n/g, "\n");
      const oldString = edit.oldString.replace(/\r\n/g, "\n");
      const newString = edit.newString.replace(/\r\n/g, "\n");
      const count = content.split(oldString).length - 1;
      if (count === 0) throw new FsError(`old_string was not found in "${t.displayPath}"`, "FS_EDIT_NOT_FOUND");
      if (count > 1 && !edit.replaceAll) {
        throw new FsError(`old_string matched ${count} times in "${t.displayPath}"; provide a more specific old_string or set replace_all to true`, "FS_AMBIGUOUS_EDIT");
      }
      const after = edit.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
      write(t.targetKey, crlf ? after.replace(/\n/g, "\r\n") : after);
      return { version: probe(t.targetKey).version, before: content, after };
    },
  };
  return fs;
}

/** An events hub with cordis' waterfall/emit ordering. */
export function fakeCtx(fs, services = {}) {
  const hooks = {};
  const ctx = {
    fs,
    logger: { warn() {} },
    on(name, fn) {
      (hooks[name] ??= []).push(fn);
      return () => {};
    },
    waterfall(name, ...args) {
      const inner = args.pop();
      const cbs = [...(hooks[name] ?? [])];
      const next = () => (cbs.shift() ?? inner)(...args, next);
      return next();
    },
    emit(name, ...args) {
      for (const fn of hooks[name] ?? []) fn(...args);
    },
    get(name) {
      return name === "fs" ? ctx.fs : services[name];
    },
    effect() {},
    inject(_names, fn) {
      if (services.systemPrompt) fn(ctx);
    },
    tools: services.tools ?? { register() {}, get() { return undefined; } },
    systemPrompt: services.systemPrompt,
    hooks,
  };
  return ctx;
}

/** A fake agent exec for one session. */
export function fakeExec(name, args, session = { header: { cwd: undefined } }) {
  return { name, arguments: args, agent: { session }, signal: new AbortController().signal, callId: `c-${Math.random()}` };
}

/** Run a tool call through the ctx's tools/execute and tools/post-execute chains. */
export async function runTool(ctx, exec, body, render) {
  let result = await ctx.waterfall("tools/execute", exec, body);
  // dsh renders a wrapper's bare value through the tool's own output.render
  if (!result.isError && !result.content && render) result = { ...result, content: render(exec.arguments, result.value) };
  const decision = await ctx.waterfall("tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
  const final = decision.content ? { ...result, content: decision.content } : result;
  ctx.emit("tools/result", exec, final);
  return final;
}

export const textOf = (result) => result.content.map((b) => b.text).join("");
