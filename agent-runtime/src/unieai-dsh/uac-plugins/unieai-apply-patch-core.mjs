// Copyright (c) 2026 UnieAI. All rights reserved.
/**
 * unieai-apply-patch-core.mjs — codex's `apply_patch` format, parsed and
 * applied to text. Pure; the dsh tool lives in unieai-apply-patch.mjs.
 *
 * Ported from codex-rs/apply-patch (upstream/main): parser.rs +
 * streaming_parser.rs (Lenient mode), file_update.rs (`compute_replacements`,
 * NormalizeToLf, except that matched context lines keep the file's text and
 * lines added by a whitespace-insensitive match are re-indented) and
 * seek_sequence.rs. Error texts are codex's, verbatim, so a
 * model trained on codex reads the diagnostics it expects.
 *
 *   start:        begin_patch hunk+ end_patch
 *   add_hunk:     "*** Add File: " filename LF ("+" line LF)+
 *   delete_hunk:  "*** Delete File: " filename LF
 *   update_hunk:  "*** Update File: " filename LF change_move? change?
 *   change_move:  "*** Move to: " filename LF
 *   change:       (("@@" | "@@ " text) LF | (" " | "+" | "-") text LF)+ ("*** End of File" LF)?
 */
import { reindent, seekSequence, seekSequenceTier } from "./unieai-edit-match.mjs";

export const BEGIN_PATCH = "*** Begin Patch";
export const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CONTEXT = "@@ ";
const EMPTY_CONTEXT = "@@";
const ENVIRONMENT_ID = "*** Environment ID:";

export class PatchParseError extends Error {
  constructor(message, lineNumber = null) {
    super(lineNumber === null ? `invalid patch: ${message}` : `invalid hunk at line ${lineNumber}, ${message}`);
    this.name = "PatchParseError";
    this.lineNumber = lineNumber;
  }
}

export class PatchApplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PatchApplyError";
  }
}

const invalidHeader = (trimmed, n) =>
  new PatchParseError(
    `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    n,
  );
const unexpectedUpdateLine = (line, n) =>
  new PatchParseError(
    `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    n,
  );

const emptyChunk = () => ({ context: null, oldLines: [], newLines: [], contextIndices: [], isEndOfFile: false });

/**
 * Strip what models wrap around the envelope: a JSON-ish `apply_patch` shell
 * invocation or a heredoc (`<<'EOF' … EOF`). codex accepts the bare heredoc
 * form; the `apply_patch <<EOF` prefix is how its shell interception sees it.
 */
export function unwrapPatch(text) {
  let s = String(text ?? "").replace(/\r\n/g, "\n").trim();
  const lines = s.split("\n");
  const first = lines[0]?.trim() ?? "";
  const heredoc = /^(?:(?:cd\s+\S+\s*&&\s*)?(?:apply_patch|applypatch)\s*)?<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(first);
  if (heredoc && lines.length >= 3) {
    const tag = heredoc[2];
    const last = lines[lines.length - 1].trim();
    if (last === tag) s = lines.slice(1, -1).join("\n");
    else if (last.endsWith(tag)) s = lines.slice(1, -1).join("\n");
  }
  return s;
}

/**
 * Parse a patch (Lenient mode). @returns {{hunks: Array, environmentId: string|null}}
 * hunks: {kind:"add", path, contents} | {kind:"delete", path}
 *      | {kind:"update", path, movePath, chunks:[{context, oldLines, newLines, isEndOfFile}]}
 */
export function parsePatch(text) {
  const all = unwrapPatch(text).split("\n");
  const firstTrim = all[0]?.trim();
  const lastTrim = all[all.length - 1]?.trim();
  if (firstTrim !== BEGIN_PATCH) throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
  if (lastTrim !== END_PATCH) throw new PatchParseError("The last line of the patch must be '*** End Patch'");

  const hunks = [];
  let environmentId = null;
  let mode = "start"; // start | add | delete | update | ended
  let hunkLine = 0;

  const ensureUpdateNotEmpty = (trimmed, n) => {
    const last = hunks[hunks.length - 1];
    if (last?.kind !== "update" || mode !== "update") return;
    if (last.chunks.length === 0) throw new PatchParseError(`Update file hunk for path '${last.path}' is empty`, hunkLine);
    const tail = last.chunks[last.chunks.length - 1];
    if (tail.oldLines.length === 0 && tail.newLines.length === 0) {
      if (trimmed === END_PATCH) throw new PatchParseError("Update hunk does not contain any lines", n);
      throw unexpectedUpdateLine(trimmed, n);
    }
  };

  const headerOrEnd = (trimmed, n) => {
    if (mode === "start" && trimmed.startsWith(ENVIRONMENT_ID)) {
      if (environmentId !== null) throw new PatchParseError("apply_patch environment_id cannot be specified more than once");
      const id = trimmed.slice(ENVIRONMENT_ID.length).trim();
      if (!id) throw new PatchParseError("apply_patch environment_id cannot be empty");
      environmentId = id;
      return true;
    }
    if (trimmed === END_PATCH) {
      ensureUpdateNotEmpty(trimmed, n);
      mode = "ended";
      return true;
    }
    if (trimmed.startsWith(ADD_FILE)) {
      ensureUpdateNotEmpty(trimmed, n);
      hunks.push({ kind: "add", path: trimmed.slice(ADD_FILE.length), contents: "" });
      mode = "add";
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE)) {
      ensureUpdateNotEmpty(trimmed, n);
      hunks.push({ kind: "delete", path: trimmed.slice(DELETE_FILE.length) });
      mode = "delete";
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE)) {
      ensureUpdateNotEmpty(trimmed, n);
      hunks.push({ kind: "update", path: trimmed.slice(UPDATE_FILE.length), movePath: null, chunks: [] });
      mode = "update";
      hunkLine = n;
      return true;
    }
    return false;
  };

  for (let k = 0; k < all.length; k++) {
    const n = k + 1;
    const line = all[k];
    const trimmed = line.trim();
    if (k === all.length - 1 && k > 0 && trimmed === END_PATCH) {
      // codex `finish`: the final line is always the end marker, trimmed.
      ensureUpdateNotEmpty(trimmed, n);
      mode = "ended";
      continue;
    }
    switch (mode) {
      case "start":
        if (k === 0) continue; // Begin Patch, checked above
        if (headerOrEnd(trimmed, n)) continue;
        throw invalidHeader(trimmed, n);
      case "add": {
        if (headerOrEnd(trimmed, n)) continue;
        if (line.startsWith("+")) {
          hunks[hunks.length - 1].contents += `${line.slice(1)}\n`;
          continue;
        }
        throw invalidHeader(trimmed, n);
      }
      case "delete":
        if (headerOrEnd(trimmed, n)) continue;
        throw invalidHeader(trimmed, n);
      case "update": {
        const updateLine = line.trimEnd();
        if (headerOrEnd(updateLine, n)) continue;
        const hunk = hunks[hunks.length - 1];
        const chunks = hunk.chunks;
        const tail = chunks[chunks.length - 1];
        const tailEmpty = tail && tail.oldLines.length === 0 && tail.newLines.length === 0;
        if (tail?.isEndOfFile) {
          if (updateLine === "") continue;
          if (updateLine !== EMPTY_CONTEXT && !updateLine.startsWith(CONTEXT)) {
            throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, n);
          }
        }
        if (chunks.length === 0 && hunk.movePath === null && updateLine.startsWith(MOVE_TO)) {
          hunk.movePath = updateLine.slice(MOVE_TO.length);
          continue;
        }
        if ((updateLine === EMPTY_CONTEXT || updateLine.startsWith(CONTEXT)) && tailEmpty) {
          throw unexpectedUpdateLine(line, n);
        }
        if (updateLine === EMPTY_CONTEXT) {
          chunks.push(emptyChunk());
          continue;
        }
        if (updateLine.startsWith(CONTEXT)) {
          chunks.push({ ...emptyChunk(), context: updateLine.slice(CONTEXT.length) });
          continue;
        }
        if (updateLine === EOF_MARKER) {
          if (tailEmpty) throw new PatchParseError("Update hunk does not contain any lines", n);
          if (tail) tail.isEndOfFile = true;
          continue;
        }
        const current = () => {
          if (chunks.length === 0) chunks.push(emptyChunk());
          return chunks[chunks.length - 1];
        };
        if (line === "") {
          const c = current();
          c.contextIndices.push([c.oldLines.length, c.newLines.length]);
          c.oldLines.push("");
          c.newLines.push("");
          continue;
        }
        if (line.startsWith(" ")) {
          const c = current();
          c.contextIndices.push([c.oldLines.length, c.newLines.length]);
          c.oldLines.push(line.slice(1));
          c.newLines.push(line.slice(1));
          continue;
        }
        if (line.startsWith("+")) {
          current().newLines.push(line.slice(1));
          continue;
        }
        if (line.startsWith("-")) {
          current().oldLines.push(line.slice(1));
          continue;
        }
        if (tail && (tail.oldLines.length || tail.newLines.length)) {
          throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${line}'`, n);
        }
        throw unexpectedUpdateLine(line, n);
      }
      case "ended":
        if (trimmed === "") continue;
        throw new PatchParseError("The last line of the patch must be '*** End Patch'");
      default:
        throw new Error(`unreachable parser mode ${mode}`);
    }
  }
  if (mode !== "ended") throw new PatchParseError("The last line of the patch must be '*** End Patch'");
  return { hunks, environmentId };
}

/**
 * codex `compute_replacements` + `apply_replacements` (NormalizeToLf).
 * @param {string} original file text (LF)
 * @returns {string} new text, always ending in a newline
 */
export function applyChunks(original, chunks, path) {
  const lines = original.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const replacements = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.context !== null && chunk.context !== undefined) {
      const idx = seekSequence(lines, [chunk.context], lineIndex, false);
      if (idx < 0) throw new PatchApplyError(`Failed to find context '${chunk.context}' in ${path}`);
      lineIndex = idx + 1;
    }
    if (chunk.oldLines.length === 0) {
      const at = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      replacements.push([at, 0, chunk.newLines.slice()]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let { index: found, tier } = seekSequenceTier(lines, pattern, lineIndex, chunk.isEndOfFile);
    if (found < 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      ({ index: found, tier } = seekSequenceTier(lines, pattern, lineIndex, chunk.isEndOfFile));
    }
    if (found < 0) {
      throw new PatchApplyError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }
    // Context lines keep the file's own text: a fuzzy match must not rewrite
    // lines the patch did not mean to change (codex PreserveLineEndings does
    // the same via context_line_indices).
    // Matched only after trimming: added lines move onto the file's
    // indentation (e.g. spaces written for a tab-indented file).
    const segment = tier >= 2 ? reindent(newSlice, pattern, lines.slice(found, found + pattern.length)) : newSlice.slice();
    for (const [o, n] of chunk.contextIndices ?? []) {
      if (o < pattern.length && n < segment.length) segment[n] = lines[found + o];
    }
    replacements.push([found, pattern.length, segment]);
    lineIndex = found + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  const out = lines.slice();
  for (const [start, oldLen, segment] of replacements.slice().reverse()) {
    out.splice(start, Math.min(oldLen, Math.max(0, out.length - start)), ...segment);
  }
  if (out.length === 0 || out[out.length - 1] !== "") out.push("");
  return out.join("\n");
}

/** The paths a hunk touches, source first. */
export function hunkPaths(hunk) {
  return hunk.kind === "update" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path];
}

/** codex `print_summary`. */
export function summarize(changes) {
  const letter = { add: "A", update: "M", delete: "D" };
  return ["Success. Updated the following files:", ...changes.map((c) => `${letter[c.kind]} ${c.movePath ?? c.path}`)].join("\n");
}

export const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Pass the whole patch as the \`input\` string.
The patch format is a stripped-down, file-oriented diff:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Each file section starts with one of:
*** Add File: <path> - create a new file; every following line starts with + (the initial contents)
*** Delete File: <path> - remove an existing file; nothing follows
*** Update File: <path> - patch an existing file in place (optionally followed by "*** Move to: <new path>" to rename it)

An Update section has one or more hunks, each introduced by @@ (optionally followed by a line such as a class or function header to locate the hunk). Inside a hunk, every line starts with:
" " (space) for an unchanged context line, "-" for a removed line, "+" for an added line.
Show 3 lines of context above and below each change; if that is not unique, add @@ lines naming the enclosing class/function. Hunks must be in file order. "*** End of File" may follow a hunk that changes the end of the file.

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-    print("Hi")
+    print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Paths are relative to the working directory (or absolute). New lines must be prefixed with + even when creating a file. Matching tolerates whitespace and typographic-punctuation differences. The call fails without changing anything if a hunk does not apply; you do not need to re-read files after a successful call.`;
