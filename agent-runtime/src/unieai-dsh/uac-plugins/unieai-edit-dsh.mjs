// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-dsh.mjs — dsh glue shared by the unieai-edit-* and
 * unieai-apply-patch plugins: the session workspace, the per-call sandbox
 * policy, and composing extra text onto a tool result in `tools/post-execute`.
 *
 * Mirrors what `@deepseek-ai/dsh-tool-fs` does privately (session-cwd.ts,
 * sandbox.ts), since those helpers are not exported.
 */
import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
import { canonicalPath, sandboxDenialMarker, writableRoots } from "@deepseek-ai/dsh-sandbox";

export { FsError };

/** The calling agent's session workspace, or undefined for agentless calls. */
export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd;
}

/**
 * The standing sandbox policy for this call (no escalation), or undefined when
 * the mounted filesystem does not confine.
 */
export function policyFor(ctx, exec) {
  // ctx.get: callers that do not inject `fs` may not touch ctx.fs.
  if (ctx.get("fs")?.sandboxMode === undefined) return undefined;
  const service = ctx.get("sandboxPolicy");
  if (!service) return undefined;
  return service.resolve(exec?.agent ? { session: exec.agent.session } : {});
}

/** Resolve a model path the way dsh's fs tools do. */
export function resolveTarget(ctx, exec, path, policy) {
  const cwd = policy?.workspaceRoot ?? sessionCwd(exec);
  return ctx.fs.resolve(path, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
}

/** The model-facing text of an fs error, with dsh's remedies. */
export function fsErrorMessage(error, displayPath, policy) {
  if (error instanceof FsError || typeof error?.code === "string") {
    if (error.code === "FS_SANDBOX_DENIED" && policy) return sandboxDenialMarker(policy.mode);
    if (error.code === "FS_NOT_OBSERVED") return `cannot modify "${displayPath}": file has not been read — read the file, then retry`;
    if (error.code === "FS_STALE_VERSION") return `${error.message} — re-read the file, then retry`;
  }
  return error?.message ?? String(error);
}

/** Text of a content block list. */
export function contentText(content) {
  return (content ?? []).map((b) => (b?.type === "text" ? b.text : "")).join("");
}

/**
 * Register a `tools/post-execute` listener that appends text to the result
 * the model sees, composing with other listeners: `extra(exec, result)`
 * returns a string (or nothing).
 */
export function appendOnPostExecute(ctx, extra) {
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    if (decision?.kind !== "accept" || Object.hasOwn(decision, "value")) return decision;
    let text;
    try {
      text = await extra(exec, result);
    } catch (error) {
      ctx.logger?.warn?.(`post-execute note failed: ${error?.message ?? error}`);
      return decision;
    }
    if (!text) return decision;
    const base = decision.content ?? result.content ?? [];
    return { ...decision, content: [...base, { type: "text", text }] };
  });
}

function isUnder(child, root) {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Delete a file. dsh's fs service has no delete, so this is done on the host
 * directly, after the same fence `dsh-fs-sandbox` applies to writes
 * (read-only denies; workspace-write requires the canonical path under a
 * writable root) and a version check against `expectedVersion`.
 * Only for a host-local filesystem backend.
 */
export async function removeFile(ctx, target, { expectedVersion, policy, signal } = {}) {
  const hostPath = ctx.fs.processPath(target);
  if (ctx.fs.processPathFromHostPath?.(hostPath) !== hostPath) {
    throw new FsError(`cannot delete "${target.displayPath}": this filesystem backend does not support deletion; use the shell`, "FS_IO_ERROR");
  }
  if (policy && policy.mode !== "danger-full-access") {
    if (policy.mode === "read-only") {
      throw new FsError(`cannot delete "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
    }
    // Canonicalize the parent (the file itself may be a symlink we remove).
    const parent = await realpath(dirname(hostPath));
    const canonical = join(parent, basename(hostPath));
    const roots = writableRoots(policy);
    if (!roots.some((root) => isUnder(canonical, canonicalPath(root)))) {
      throw new FsError(`cannot delete "${target.displayPath}": outside the writable roots`, "FS_SANDBOX_DENIED");
    }
  }
  if (signal?.aborted) throw new FsError("delete aborted", "FS_ABORTED");
  if (expectedVersion !== undefined) {
    const info = await ctx.fs.stat(target, signal);
    if (!info) throw new FsError(`cannot delete "${target.displayPath}": file no longer exists`, "FS_STALE_VERSION");
    if (info.version !== expectedVersion) throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
  }
  const st = await lstat(hostPath).catch(() => null);
  if (st?.isDirectory()) throw new FsError(`cannot delete "${target.displayPath}": is a directory`, "FS_NOT_REGULAR_FILE");
  try {
    await unlink(hostPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new FsError(`cannot delete "${target.displayPath}": not found`, "FS_NOT_FOUND", { cause: error });
    if (error?.code === "EACCES" || error?.code === "EPERM") throw new FsError(`cannot delete "${target.displayPath}": permission denied`, "FS_PERMISSION_DENIED", { cause: error });
    throw new FsError(`cannot delete "${target.displayPath}": ${error.message}`, "FS_IO_ERROR", { cause: error });
  }
}
