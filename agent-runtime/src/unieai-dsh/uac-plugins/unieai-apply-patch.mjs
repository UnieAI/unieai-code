// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-apply-patch.mjs — codex's `apply_patch` as a dsh tool.
 *
 * One call adds, updates, moves and deletes files using codex's patch format
 * and fuzzy line matching (unieai-apply-patch-core.mjs). Everything goes
 * through dsh's fs service so the sandbox fence, version checks and
 * observation policy apply:
 *
 *  1. verify: parse, resolve every path, read every Update/Delete source and
 *     compute the new text. Any failure is reported before anything is written.
 *  2. commit, in patch order: Update = `editText` replacing the whole verified
 *     text (atomic, version-checked, line endings restored); Add = `writeText`
 *     under the `fs/write-intent` guard; Move = `writeText` to the destination
 *     then delete the source; Delete = a fenced host unlink (dsh's fs service
 *     has no delete — see removeFile in unieai-edit-dsh.mjs).
 *  3. on a commit failure, earlier changes are rolled back best-effort.
 *
 * The result the model sees is codex's summary (`Success. Updated the
 * following files: …`); the value carries per-file before/after for the UI
 * (presentationMeta.diffs) and for unieai-edit-feedback.
 *
 * Config: { name?: "apply_patch", prompt?: true }
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  APPLY_PATCH_DESCRIPTION,
  PatchApplyError,
  PatchParseError,
  applyChunks,
  parsePatch,
  summarize,
} from "./unieai-apply-patch-core.mjs";
import { FsError, fsErrorMessage, policyFor, removeFile, resolveTarget } from "./unieai-edit-dsh.mjs";

export const name = "unieai-apply-patch";
export const inject = ["tools", "fs"];

const toolError = (message) => new Error(message);

/** Dominant line ending of a text, as dsh-fs-local decides it. */
function usesCrlf(text) {
  const head = text.slice(0, 4096);
  const crlf = (head.match(/\r\n/g) ?? []).length;
  const lf = (head.match(/\n/g) ?? []).length - crlf;
  return crlf > lf;
}

const withEol = (text, crlf) => (crlf ? text.replace(/\n/g, "\r\n") : text);

/** The observation policy's guard for an update/delete, checked up front. */
async function editIntent(ctx, exec, target, info, policy, { allowUnobserved = false } = {}) {
  let intent;
  try {
    intent = await ctx.waterfall("fs/edit-intent", target, exec, () => undefined);
  } catch (error) {
    // Deleting needs no knowledge of the content; only a stale view blocks it.
    if (allowUnobserved && error?.code === "FS_NOT_OBSERVED") return undefined;
    throw toolError(`apply_patch verification failed: ${fsErrorMessage(error, target.displayPath, policy)}`);
  }
  if (intent && intent.version !== info.version) {
    throw toolError(`apply_patch verification failed: cannot modify "${target.displayPath}": file changed since it was read — re-read the file, then retry`);
  }
  return intent;
}

/** The observation policy's guard for a create/overwrite, checked up front. */
async function writeIntent(ctx, exec, target, info, policy) {
  let intent;
  try {
    intent = await ctx.waterfall("fs/write-intent", target, exec, () => undefined);
  } catch (error) {
    throw toolError(`apply_patch verification failed: ${fsErrorMessage(error, target.displayPath, policy)}`);
  }
  if (info && intent?.kind === "createIfAbsent") {
    throw toolError(`apply_patch verification failed: cannot overwrite existing "${target.displayPath}" without reading it first`);
  }
  if (intent?.kind === "replaceIfVersion" && info && intent.version !== info.version) {
    throw toolError(`apply_patch verification failed: cannot overwrite "${target.displayPath}": file changed since it was read — re-read the file, then retry`);
  }
  return intent;
}

/** Verify the patch against the filesystem. Returns the planned operations. */
async function verify(ctx, exec, hunks, policy) {
  const planned = [];
  const touched = new Map();
  const claim = (target) => {
    const prior = touched.get(target.targetKey);
    if (prior !== undefined) throw toolError(`apply_patch verification failed: multiple operations target ${target.displayPath}`);
    touched.set(target.targetKey, true);
  };
  for (const hunk of hunks) {
    if (!hunk.path) throw toolError("apply_patch verification failed: a hunk has an empty path");
    const target = await resolveTarget(ctx, exec, hunk.path, policy);
    claim(target);
    const info = await ctx.fs.stat(target, exec.signal);
    if (hunk.kind === "add") {
      if (info && info.type !== "file") throw toolError(`apply_patch verification failed: ${target.displayPath} exists and is not a regular file`);
      const before = info ? await ctx.fs.readText(target, exec.signal) : null;
      const intent = await writeIntent(ctx, exec, target, info, policy);
      planned.push({ kind: "add", hunk, target, info, intent, beforeRaw: before, after: hunk.contents });
      continue;
    }
    if (!info) {
      const verb = hunk.kind === "delete" ? "delete" : "update";
      throw toolError(`apply_patch verification failed: Failed to read file to ${verb} ${target.displayPath}: No such file or directory`);
    }
    if (info.type !== "file") throw toolError(`apply_patch verification failed: ${target.displayPath} is not a regular file`);
    const raw = await ctx.fs.readText(target, exec.signal);
    await editIntent(ctx, exec, target, info, policy, { allowUnobserved: hunk.kind === "delete" });
    if (hunk.kind === "delete") {
      planned.push({ kind: "delete", hunk, target, info, beforeRaw: raw });
      continue;
    }
    const before = raw.replace(/\r\n/g, "\n");
    let after;
    try {
      after = applyChunks(before, hunk.chunks, target.displayPath);
    } catch (error) {
      if (error instanceof PatchApplyError) throw toolError(`apply_patch verification failed: ${error.message}`);
      throw error;
    }
    let dest = null;
    let destInfo = null;
    if (hunk.movePath) {
      dest = await resolveTarget(ctx, exec, hunk.movePath, policy);
      if (dest.targetKey !== target.targetKey) claim(dest);
      destInfo = await ctx.fs.stat(dest, exec.signal);
      if (destInfo && destInfo.type !== "file") throw toolError(`apply_patch verification failed: ${dest.displayPath} exists and is not a regular file`);
      if (dest.targetKey === target.targetKey) dest = null;
    }
    const destIntent = dest ? await writeIntent(ctx, exec, dest, destInfo, policy) : undefined;
    planned.push({ kind: "update", hunk, target, info, beforeRaw: raw, before, after, crlf: usesCrlf(raw), dest, destInfo, destIntent });
  }
  return planned;
}

/** Apply one planned op; returns an undo function and the change record. */
async function commit(ctx, exec, op, policy) {
  const signal = exec.signal;
  const observe = (target, observation) => ctx.emit("fs/observed", target, observation, exec);
  if (op.kind === "add") {
    const out = await ctx.fs.writeText(op.target, op.after, op.intent, signal, policy);
    observe(op.target, { kind: "present", version: out.version });
    const undo = op.beforeRaw === null
      ? () => removeFile(ctx, op.target, { policy })
      : () => ctx.fs.writeText(op.target, op.beforeRaw, undefined, undefined, policy);
    return { undo, change: { kind: "add", path: op.target.displayPath, before: op.beforeRaw === null ? null : op.beforeRaw.replace(/\r\n/g, "\n"), after: op.after } };
  }
  if (op.kind === "delete") {
    await removeFile(ctx, op.target, { expectedVersion: op.info.version, policy, signal });
    observe(op.target, { kind: "absent" });
    return {
      undo: () => ctx.fs.writeText(op.target, op.beforeRaw, undefined, undefined, policy),
      change: { kind: "delete", path: op.target.displayPath, before: op.beforeRaw.replace(/\r\n/g, "\n"), after: null },
    };
  }
  // update
  if (op.dest) {
    const destIntent = op.destIntent;
    const destBefore = op.destInfo ? await ctx.fs.readText(op.dest, signal).catch(() => null) : null;
    const out = await ctx.fs.writeText(op.dest, withEol(op.after, op.crlf), destIntent, signal, policy);
    observe(op.dest, { kind: "present", version: out.version });
    try {
      await removeFile(ctx, op.target, { expectedVersion: op.info.version, policy, signal });
    } catch (error) {
      await (destBefore === null
        ? removeFile(ctx, op.dest, { policy })
        : ctx.fs.writeText(op.dest, destBefore, undefined, undefined, policy)
      ).catch(() => {});
      throw error;
    }
    observe(op.target, { kind: "absent" });
    return {
      undo: async () => {
        await ctx.fs.writeText(op.target, op.beforeRaw, undefined, undefined, policy);
        if (destBefore === null) await removeFile(ctx, op.dest, { policy });
        else await ctx.fs.writeText(op.dest, destBefore, undefined, undefined, policy);
      },
      change: { kind: "update", path: op.target.displayPath, movePath: op.dest.displayPath, before: op.before, after: op.after },
    };
  }
  let out;
  if (op.before === "") {
    out = await ctx.fs.writeText(op.target, op.after, { kind: "replaceIfVersion", version: op.info.version }, signal, policy);
  } else if (op.before === op.after) {
    out = { version: op.info.version };
  } else {
    out = await ctx.fs.editText(
      op.target,
      { oldString: op.before, newString: op.after, replaceAll: false },
      { version: op.info.version },
      signal,
      policy,
    );
  }
  observe(op.target, { kind: "present", version: out.version });
  return {
    undo: () => ctx.fs.writeText(op.target, op.beforeRaw, undefined, undefined, policy),
    change: { kind: "update", path: op.target.displayPath, before: op.before, after: op.after },
  };
}

export async function runApplyPatch(ctx, exec, input) {
  let parsed;
  try {
    parsed = parsePatch(input);
  } catch (error) {
    if (error instanceof PatchParseError) throw toolError(`apply_patch verification failed: ${error.message}`);
    throw error;
  }
  if (!parsed.hunks.length) throw toolError("No files were modified.");
  const policy = policyFor(ctx, exec);
  let planned;
  try {
    planned = await verify(ctx, exec, parsed.hunks, policy);
  } catch (error) {
    if (error instanceof FsError) throw toolError(`apply_patch verification failed: ${fsErrorMessage(error, "", policy)}`);
    throw error;
  }
  const done = [];
  for (const op of planned) {
    try {
      done.push(await commit(ctx, exec, op, policy));
    } catch (error) {
      const rollbackFailures = [];
      for (const d of done.slice().reverse()) {
        try {
          await d.undo();
        } catch (undoError) {
          rollbackFailures.push(`${d.change.path}: ${undoError.message}`);
        }
      }
      const shown = op.dest?.displayPath ?? op.target.displayPath;
      const why = fsErrorMessage(error, shown, policy);
      const rolled = done.length
        ? rollbackFailures.length
          ? ` Rolling back earlier files failed for: ${rollbackFailures.join("; ")}.`
          : " Earlier files in this patch were restored; nothing was changed."
        : " Nothing was changed.";
      const wrapped = new FsError(`apply_patch failed on ${shown}: ${why}.${rolled}`, error?.code ?? "FS_IO_ERROR", { cause: error });
      throw wrapped;
    }
  }
  const changes = done.map((d) => d.change);
  return { summary: summarize(changes), files: changes };
}

const fileSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", required: true, enum: ["add", "update", "delete"] },
    path: { type: "string", required: true },
    movePath: { type: "string" },
    before: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
    after: { required: true, oneOf: [{ type: "string" }, { type: "null" }] },
  },
};

/** FileDiff list for dsh's diff card. */
export function diffsOf(files) {
  return files.map((f) => ({
    path: f.movePath ?? f.path,
    oldText: f.before,
    newText: f.after ?? "",
  }));
}

/** Call-time card: what the patch says, per file. */
export function previewDiffs(input) {
  try {
    const { hunks } = parsePatch(input);
    return hunks.map((h) => {
      if (h.kind === "add") return { path: h.path, oldText: null, newText: h.contents };
      if (h.kind === "delete") return { path: h.path, oldText: "(deleted)", newText: "" };
      return {
        path: h.movePath ?? h.path,
        oldText: h.chunks.map((c) => c.oldLines.join("\n")).join("\n…\n"),
        newText: h.chunks.map((c) => c.newLines.join("\n")).join("\n…\n"),
      };
    });
  } catch {
    return [];
  }
}

export function createApplyPatchTool(ctx, toolName = "apply_patch") {
  return defineTool({
    name: toolName,
    description: APPLY_PATCH_DESCRIPTION,
    parameters: {
      input: {
        type: "string",
        required: true,
        description: "The entire patch, from '*** Begin Patch' to '*** End Patch'.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          files: { type: "array", required: true, items: fileSchema },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.summary }],
      presentationMeta: (_args, value) => ({ diffs: diffsOf(value.files) }),
    },
    async execute(args, exec) {
      return runApplyPatch(ctx, exec, args.input);
    },
    presentCall(args) {
      const diffs = previewDiffs(args.input);
      return diffs.length
        ? { card: "diff", title: "Apply patch", diffs, locations: diffs.map((d) => ({ path: d.path })) }
        : { card: "generic", title: "Apply patch" };
    },
    presentResult(_args, result) {
      if (result.isError) return undefined;
      const diffs = result.meta?.diffs;
      return Array.isArray(diffs) && diffs.length ? { card: "diff", title: "Apply patch", diffs } : undefined;
    },
  });
}

export function apply(ctx, config = {}) {
  const toolName = config.name ?? "apply_patch";
  ctx.tools.register(createApplyPatchTool(ctx, toolName));
  if (config.prompt !== false) {
    ctx.inject(["systemPrompt"], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: "unieai:apply-patch",
        order: (promptCtx.systemPrompt.getSectionOrder("TOOL_EDIT") ?? 1300) + 2,
        text: ({ scope }) =>
          ctx.tools.get(toolName, scope) === undefined
            ? ""
            : `Use the ${toolName} tool for multi-line or multi-file changes, creating, moving and deleting files (codex patch format). ` +
              `Do not re-read a file after a successful ${toolName}: the call fails if the patch did not apply.`,
      });
    });
  }
}
