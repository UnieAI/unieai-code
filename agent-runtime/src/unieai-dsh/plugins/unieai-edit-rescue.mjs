// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-edit-rescue.mjs — recover dsh `edit` calls that miss on whitespace.
 *
 * dsh's `edit` is a literal, unique `indexOf`. When it fails with
 * FS_EDIT_NOT_FOUND this plugin retries the match line by line with codex's
 * levels (exact → trailing whitespace → surrounding whitespace → unicode
 * punctuation), also dropping `12: ` prefixes copied from `read` output. A
 * unique match is applied through `ctx.fs.editText` (same lock, version check,
 * line-ending restore and sandbox fence as the real edit); otherwise the error
 * the model sees gains the closest lines with their numbers. FS_AMBIGUOUS_EDIT
 * gains the line numbers of each occurrence.
 *
 * Hook: `tools/execute` (a failed result's value cannot be replaced in
 * `tools/post-execute`). The value returned is the `edit` tool's own output
 * shape, so dsh renders and presents it as a normal edit; a note naming the
 * match level is appended in `tools/post-execute`.
 */
import { literalLineNumbers, notFoundHint, planFuzzyEdit } from "./unieai-edit-match.mjs";
import { appendOnPostExecute, fsErrorMessage, policyFor, resolveTarget } from "./unieai-edit-dsh.mjs";

export const name = "unieai-edit-rescue";
export const inject = ["tools", "fs"];

const errorResult = (result, message) => ({
  ...result,
  isError: true,
  content: [{ type: "text", text: `Error: ${message}` }],
  error: { ...result.error, message },
});

export function apply(ctx, config = {}) {
  const tools = new Set(config.tools ?? ["edit"]);
  const notes = new WeakMap();

  ctx.on("tools/execute", async (exec, next) => {
    const result = await next();
    if (!tools.has(exec.name) || !result?.isError) return result;
    const code = result.error?.info?.code;
    if (code !== "FS_EDIT_NOT_FOUND" && code !== "FS_AMBIGUOUS_EDIT") return result;
    try {
      return await rescue(ctx, exec, result, code, notes);
    } catch (error) {
      ctx.logger?.warn?.(`unieai-edit-rescue: ${error?.message ?? error}`);
      return result;
    }
  });

  appendOnPostExecute(ctx, (exec, result) => (result.isError ? undefined : notes.get(exec)));
}

async function rescue(ctx, exec, result, code, notes) {
  const args = exec.arguments ?? {};
  const oldString = String(args.old_string ?? "").replace(/\r\n/g, "\n");
  const newString = String(args.new_string ?? "").replace(/\r\n/g, "\n");
  const replaceAll = args.replace_all === true;
  const policy = policyFor(ctx, exec);
  const target = await resolveTarget(ctx, exec, String(args.file_path), policy);
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info || info.type !== "file") return result;
  const content = (await ctx.fs.readText(target, exec.signal)).replace(/\r\n/g, "\n");

  if (code === "FS_AMBIGUOUS_EDIT") {
    const at = literalLineNumbers(content, oldString);
    if (!at.length) return result;
    return errorResult(
      result,
      `${result.error.message} (occurrences start at line ${at.join(", ")}). ` +
        "Include enough surrounding lines to make old_string unique, or set replace_all to true.",
    );
  }

  const plan = planFuzzyEdit(content, oldString, newString, { replaceAll });
  if (!plan.ok) {
    if (plan.reason === "ambiguous") {
      return errorResult(
        result,
        `old_string was not found verbatim in "${target.displayPath}"; ${plan.tier}, it matches ${plan.lines.length} places ` +
          `(starting at line ${plan.lines.slice(0, 10).join(", ")}). Include more surrounding lines to make it unique, or set replace_all to true.`,
      );
    }
    if (plan.reason === "no-change") return result;
    return errorResult(
      result,
      `${result.error.message} (also tried ignoring whitespace and unicode punctuation).\n${notFoundHint(content, oldString)}`,
    );
  }

  // The same guard the real edit used (observation policy), then an atomic
  // whole-file replacement: CAS on the version we read, EOL restored by dsh.
  let outcome;
  try {
    const intent = await ctx.waterfall("fs/edit-intent", target, exec, () => undefined);
    if (intent && intent.version !== info.version) {
      return errorResult(result, `cannot edit "${target.displayPath}": file changed since it was read — re-read the file, then retry`);
    }
    outcome = await ctx.fs.editText(
      target,
      { oldString: content, newString: plan.content, replaceAll: false },
      { version: info.version },
      exec.signal,
      policy,
    );
  } catch (error) {
    return errorResult(result, fsErrorMessage(error, target.displayPath, policy));
  }
  ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
  const where = plan.lines.length === 1 ? `line ${plan.lines[0]}` : `lines ${plan.lines.join(", ")}`;
  const how = [plan.stripped ? "after removing line-number prefixes" : null, plan.tier !== "exact" ? plan.tier : null]
    .filter(Boolean)
    .join(", ");
  notes.set(exec, `\n(old_string did not match verbatim; applied at ${where}${how ? `, ${how}` : ""}.)`);
  return { isError: false, value: { path: target.displayPath, before: outcome.before, after: outcome.after } };
}
