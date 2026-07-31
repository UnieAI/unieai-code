/**
 * tool-output-store.mjs — spill oversized tool output to disk instead of losing
 * it to truncation (idea from opencode's tool-output-store). A huge bash/read
 * result is written whole to a store file; the model sees a head+tail preview
 * plus a marker telling it the id to retrieve the rest with the `read_output`
 * tool. The store lives under UNIEAI_HOME (outside the workspace), so retrieval
 * goes through this module rather than the workspace-scoped read tool.
 *
 * Best-effort: a store failure falls back to an in-message truncation, never an
 * error. A light age-based sweep runs on write so the store cannot grow forever.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unieaiHome } from "./config.mjs";

const DEFAULT_LIMIT = 12_000; // chars kept inline before spilling
const PREVIEW_HEAD = 4_000;
const PREVIEW_TAIL = 3_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ID_RE = /^[A-Za-z0-9_-]+$/;

function storeDir() {
  const dir = join(unieaiHome(), "tool-output");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Above this we do not attempt to parse — the parse itself would be the problem. */
const MAX_PARSE_BYTES = 64 * 1024 * 1024;

/** How many records to scan when collecting the field union for a summary. */
const FIELD_SCAN_RECORDS = 50;

/**
 * Work out what a blob actually IS, so the preview can describe its shape
 * rather than show the first few thousand characters of it.
 *
 * This matters for API responses: a 10,000-record JSON array is usually a
 * single line, so a head/tail character slice yields two fragments that are not
 * even valid JSON, and a line-based filter sees one enormous line. Knowing the
 * record count and field names lets the model ask for what it wants instead.
 */
export function describeStructure(text) {
  const s = String(text ?? "");
  const trimmed = s.trim();
  if (!trimmed || s.length > MAX_PARSE_BYTES) return { kind: "text" };
  if (trimmed[0] !== "[" && trimmed[0] !== "{") return { kind: "text" };

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "text" };
  }

  // An object with exactly one array property is the common API envelope
  // ({items: [...]}, {data: [...]}); treat the array as the payload.
  let records = null;
  let path = null;
  if (Array.isArray(parsed)) {
    records = parsed;
    path = "";
  } else if (parsed && typeof parsed === "object") {
    const arrayKeys = Object.keys(parsed).filter((k) => Array.isArray(parsed[k]));
    if (arrayKeys.length === 1) {
      records = parsed[arrayKeys[0]];
      path = arrayKeys[0];
    } else {
      return { kind: "json-object", keys: Object.keys(parsed).slice(0, 40), value: parsed };
    }
  }
  if (!records) return { kind: "text" };

  const fields = new Set();
  for (const record of records.slice(0, FIELD_SCAN_RECORDS)) {
    if (record && typeof record === "object" && !Array.isArray(record)) {
      for (const key of Object.keys(record)) fields.add(key);
    }
  }
  return {
    kind: "json-records",
    path,
    count: records.length,
    fields: [...fields],
    records,
    sample: records[0],
  };
}

/** Preview for structured records: describe the shape, do not dump the data. */
function recordsPreview(shape, id) {
  const sample = JSON.stringify(shape.sample ?? null);
  return [
    `${shape.count} records${shape.path ? ` under "${shape.path}"` : ""}, full output saved.`,
    shape.fields.length ? `fields: ${shape.fields.join(", ")}` : "records are not objects",
    `first record: ${sample.length > 600 ? `${sample.slice(0, 600)}…` : sample}`,
    "",
    "Do NOT try to read all of this into the conversation. Query it instead:",
    `  read_output("${id}", { offset, limit })      page through records`,
    `  read_output("${id}", { fields: "a,b" })      keep only those fields`,
    `  read_output("${id}", { grep: "term" })       records containing a term`,
  ].join("\n");
}

function headTailPreview(text, id, { head = PREVIEW_HEAD, tail = PREVIEW_TAIL } = {}) {
  const marker = `\n\n[... ${text.length} chars total — full output saved. Retrieve with read_output("${id}") ...]\n\n`;
  return text.slice(0, head) + marker + text.slice(-tail);
}

/** Sweep store files older than the retention window. Best-effort, silent. */
function sweep(dir) {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch { /* ignore a single bad entry */ }
    }
  } catch { /* store not readable — nothing to sweep */ }
}

/**
 * Spill `text` if it exceeds `limit`. Returns { modelText, spilled, id? }.
 * `id` seeds the store filename (a tool call id works well); a random suffix is
 * added so repeated ids never collide.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.id]      base id for the store file
 * @param {number} [opts.limit]   inline char budget before spilling
 * @param {(n:number)=>string} [opts.fallbackTruncate]  used when the store write fails
 */
let spillSeq = 0;

export function spillIfLarge(text, { id = "out", limit = DEFAULT_LIMIT, fallbackTruncate = null } = {}) {
  const s = String(text ?? "");
  if (s.length <= limit) return { modelText: s, spilled: false };
  const base = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "out";
  // Timestamp + in-process counter: unique across calls AND across processes,
  // as the docstring promises. (The old length-derived suffix collided for any
  // two same-length outputs, silently overwriting the earlier spill.)
  const suffix = Date.now().toString(36) + "-" + (spillSeq++).toString(36);
  const fileId = `${base}-${suffix}`;
  try {
    const dir = storeDir();
    sweep(dir);
    writeFileSync(join(dir, `${fileId}.txt`), s, "utf8");
    // Structured payloads get a shape summary instead of a character slice: a
    // head/tail cut through a record array produces invalid JSON on both ends.
    const shape = describeStructure(s);
    const preview = shape.kind === "json-records"
      ? recordsPreview(shape, fileId)
      : headTailPreview(s, fileId);
    return { modelText: preview, spilled: true, id: fileId, kind: shape.kind };
  } catch {
    // Store unavailable — degrade to plain truncation.
    const truncated = fallbackTruncate ? fallbackTruncate(s.length) : `${s.slice(0, limit)}\n[... truncated (${s.length} chars) ...]`;
    return { modelText: truncated, spilled: false };
  }
}

/**
 * Read a spilled output back. Optionally filter to lines matching `grep`
 * (case-insensitive substring or /regex/), and cap the returned size.
 * @returns {{ ok: boolean, text: string }}
 */
/** Build the line/record matcher shared by the text and record paths. */
function matcher(pattern) {
  const pat = String(pattern || "").trim();
  if (!pat) return null;
  if (pat.startsWith("/") && pat.lastIndexOf("/") > 0) {
    try {
      const last = pat.lastIndexOf("/");
      const rx = new RegExp(pat.slice(1, last), `${pat.slice(last + 1)}i`);
      return (s) => rx.test(s);
    } catch {
      /* fall through to substring */
    }
  }
  const needle = pat.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

/**
 * Query a spilled RECORD array: filter, project, paginate.
 *
 * Paging is by record rather than by character so a page is always valid JSON —
 * the point of this path is that the caller can act on what comes back.
 */
function readRecords(shape, { grep, fields, offset, limit, maxChars }) {
  let records = shape.records;

  const match = matcher(grep);
  if (match) {
    records = records.filter((r) => match(typeof r === "string" ? r : JSON.stringify(r)));
  }

  const wanted = String(fields || "").split(",").map((f) => f.trim()).filter(Boolean);
  if (wanted.length) {
    records = records.map((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return r;
      return Object.fromEntries(wanted.filter((k) => k in r).map((k) => [k, r[k]]));
    });
  }

  const total = records.length;
  const start = Math.max(0, Number(offset) || 0);
  // Default page kept modest: the caller can always ask for the next one, but a
  // huge default would put us right back where we started.
  const size = Math.max(1, Number(limit) || 50);
  const page = records.slice(start, start + size);

  const shown = `${total} matching record(s)${total !== shape.count ? ` of ${shape.count}` : ""}; showing ${start}–${start + page.length - 1}.`;
  let body = JSON.stringify(page, null, 2);
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n[... page truncated; use fields to narrow each record, or a smaller limit ...]`;
  }
  const more = start + page.length < total
    ? `\nMore available — next page: offset ${start + page.length}.`
    : "";
  return { ok: true, text: `${shown}${more}\n\n${body}` };
}

export function readSpilled(id, { grep = "", maxChars = 24_000, fields = "", offset = 0, limit = 0 } = {}) {
  const clean = String(id || "").trim();
  if (!ID_RE.test(clean)) return { ok: false, text: `error: invalid output id "${id}"` };
  let body;
  try {
    body = readFileSync(join(storeDir(), `${clean}.txt`), "utf8");
  } catch {
    return { ok: false, text: `error: no stored output for id "${clean}" (it may have expired)` };
  }
  // Record arrays are queried, not scanned line by line. An API array is often
  // one enormous line, which makes a line filter either return everything or
  // nothing — the one case this store most needs to handle well.
  const shape = describeStructure(body);
  if (shape.kind === "json-records") {
    return readRecords(shape, { grep, fields, offset, limit, maxChars });
  }

  let out = body;
  const match = matcher(grep);
  if (match) {
    out = body.split("\n").filter(match).join("\n") || `(no lines match ${JSON.stringify(String(grep).trim())})`;
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[... ${out.length} chars, truncated to ${maxChars}; narrow with grep ...]`;
  return { ok: true, text: out };
}

export const _internals = { headTailPreview, storeDir, DEFAULT_LIMIT };
