/**
 * apply-patch.mjs — the codex `apply_patch` envelope, parsed and applied.
 *
 * Our default editor is `edit` (exact search/replace), chosen because open
 * models handle it far better than a patch grammar. That stays the default. But
 * a model TRAINED on this format writes it well and gets to change several
 * files in one call, and codex mounts the tool precisely on that basis —
 * `apply_patch_tool_type.is_some()`, i.e. per model, not globally. This is the
 * same bargain: available to models that want it, absent for the rest.
 *
 * The grammar is codex's (codex-rs/apply-patch/src/parser.rs):
 *
 *   start:        begin_patch hunk+ end_patch
 *   add_hunk:     "*** Add File: " filename LF ("+" line LF)+
 *   delete_hunk:  "*** Delete File: " filename LF
 *   update_hunk:  "*** Update File: " filename LF change_move? change?
 *   change_move:  "*** Move to: " filename LF
 *   change:       (change_context | change_line)+ eof_line?
 *
 * Parsing and applying are separate on purpose: a patch that names a file it
 * cannot change must fail before ANY file is touched, so a bad patch leaves the
 * workspace exactly as it was rather than half-applied.
 */

export const BEGIN_PATCH = "*** Begin Patch";
export const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CONTEXT_MARKER = "@@";

export class PatchError extends Error {}

/**
 * Parse a patch into hunks. Throws PatchError with a message aimed at the model.
 *
 * @returns {Array<{kind:"add"|"delete"|"update", path:string, moveTo?:string, lines?:string[], chunks?:Array}>}
 */
export function parsePatch(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  if (lines[i]?.trim() !== BEGIN_PATCH) {
    throw new PatchError(`patch must start with \`${BEGIN_PATCH}\``);
  }
  i += 1;

  const hunks = [];
  let sawEnd = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === END_PATCH) { sawEnd = true; i += 1; break; }
    if (line.trim() === "" ) { i += 1; continue; }

    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length).trim();
      if (!path) throw new PatchError("`*** Add File:` needs a path");
      i += 1;
      const body = [];
      while (i < lines.length && lines[i].startsWith("+")) {
        body.push(lines[i].slice(1));
        i += 1;
      }
      hunks.push({ kind: "add", path, lines: body });
      continue;
    }

    if (line.startsWith(DELETE_FILE)) {
      const path = line.slice(DELETE_FILE.length).trim();
      if (!path) throw new PatchError("`*** Delete File:` needs a path");
      hunks.push({ kind: "delete", path });
      i += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length).trim();
      if (!path) throw new PatchError("`*** Update File:` needs a path");
      i += 1;
      let moveTo = null;
      if (lines[i]?.startsWith(MOVE_TO)) {
        moveTo = lines[i].slice(MOVE_TO.length).trim();
        i += 1;
      }
      // One chunk per `@@`; a leading chunk with no `@@` header is allowed,
      // which is how most single-edit patches are written.
      const chunks = [];
      let current = null;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === END_PATCH || l.startsWith(ADD_FILE) || l.startsWith(DELETE_FILE) || l.startsWith(UPDATE_FILE)) break;
        if (l.trimEnd() === CONTEXT_MARKER || l.startsWith(`${CONTEXT_MARKER} `)) {
          current = { context: l.startsWith(`${CONTEXT_MARKER} `) ? l.slice(3).trim() : "", ops: [] };
          chunks.push(current);
          i += 1;
          continue;
        }
        if (l.trim() === EOF_MARKER) { i += 1; continue; }
        if (l === "" ) {
          // A bare empty line inside a chunk is a context line for an empty
          // source line — the leading space is what a strict writer emits, but
          // trailing whitespace is routinely stripped in transit.
          if (!current) { current = { context: "", ops: [] }; chunks.push(current); }
          current.ops.push({ op: " ", text: "" });
          i += 1;
          continue;
        }
        const marker = l[0];
        if (marker !== "+" && marker !== "-" && marker !== " ") {
          throw new PatchError(`unexpected line in an update hunk (expected \`+\`, \`-\`, \` \` or \`@@\`): ${JSON.stringify(l.slice(0, 60))}`);
        }
        if (!current) { current = { context: "", ops: [] }; chunks.push(current); }
        current.ops.push({ op: marker, text: l.slice(1) });
        i += 1;
      }
      if (!chunks.length) throw new PatchError(`\`${UPDATE_FILE}${path}\` has no changes`);
      hunks.push({ kind: "update", path, moveTo, chunks });
      continue;
    }

    throw new PatchError(`unexpected line outside a hunk: ${JSON.stringify(line.slice(0, 60))}`);
  }

  if (!sawEnd) throw new PatchError(`patch must end with \`${END_PATCH}\``);
  if (!hunks.length) throw new PatchError("patch contains no hunks");
  return hunks;
}

/** Find `needle` in `haystack` starting at `from`. Returns -1 when absent. */
function findSequence(haystack, needle, from) {
  if (!needle.length) return from;
  for (let i = from; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Apply one update hunk's chunks to a file's lines.
 *
 * Each chunk's context and removed lines must appear, in order, after the
 * previous chunk — the same forward-only scan codex uses, which is what stops a
 * second chunk matching text the first one already consumed.
 */
export function applyUpdate(originalLines, chunks) {
  let out = originalLines.slice();
  let cursor = 0;
  for (const chunk of chunks) {
    // Everything the chunk expects to already be there, in order.
    const expected = chunk.ops.filter((o) => o.op === " " || o.op === "-").map((o) => o.text);
    let at = chunk.context
      ? findSequence(out, [chunk.context], cursor)
      : cursor;
    if (at < 0) throw new PatchError(`context line not found: ${JSON.stringify(chunk.context)}`);
    if (chunk.context) at += 1;

    const start = findSequence(out, expected, at);
    if (start < 0) {
      const first = expected[0] ?? "";
      throw new PatchError(
        `could not find the lines this chunk expects to change (starting ${JSON.stringify(first.slice(0, 60))}). ` +
          "Re-read the file and quote its current contents exactly."
      );
    }
    const replacement = chunk.ops.filter((o) => o.op === " " || o.op === "+").map((o) => o.text);
    out = [...out.slice(0, start), ...replacement, ...out.slice(start + expected.length)];
    cursor = start + replacement.length;
  }
  return out;
}

/**
 * The flag that makes the codex binary run as `apply_patch`.
 *
 * `codex-rs/arg0/src/lib.rs` dispatches on it (`CODEX_CORE_APPLY_PATCH_ARG1`),
 * applying the patch in the process's working directory with the real parser —
 * fuzzy context matching, streaming, move handling and all. Using it is why the
 * parser above is only a preflight.
 */
export const APPLY_PATCH_ARG = "--codex-run-as-apply-patch";
