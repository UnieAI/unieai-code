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
export function spillIfLarge(text, { id = "out", limit = DEFAULT_LIMIT, fallbackTruncate = null } = {}) {
  const s = String(text ?? "");
  if (s.length <= limit) return { modelText: s, spilled: false };
  const base = String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "out";
  // Deterministic-ish suffix without Math.random dependency at import time.
  const suffix = (s.length % 100000).toString(36) + base.length.toString(36);
  const fileId = `${base}-${suffix}`;
  try {
    const dir = storeDir();
    sweep(dir);
    writeFileSync(join(dir, `${fileId}.txt`), s, "utf8");
    return { modelText: headTailPreview(s, fileId), spilled: true, id: fileId };
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
export function readSpilled(id, { grep = "", maxChars = 24_000 } = {}) {
  const clean = String(id || "").trim();
  if (!ID_RE.test(clean)) return { ok: false, text: `error: invalid output id "${id}"` };
  let body;
  try {
    body = readFileSync(join(storeDir(), `${clean}.txt`), "utf8");
  } catch {
    return { ok: false, text: `error: no stored output for id "${clean}" (it may have expired)` };
  }
  let out = body;
  const pat = String(grep || "").trim();
  if (pat) {
    let match;
    const rx = pat.startsWith("/") && pat.lastIndexOf("/") > 0
      ? (() => { try { const last = pat.lastIndexOf("/"); return new RegExp(pat.slice(1, last), pat.slice(last + 1) + "i"); } catch { return null; } })()
      : null;
    match = rx ? (line) => rx.test(line) : (line) => line.toLowerCase().includes(pat.toLowerCase());
    out = body.split("\n").filter(match).join("\n") || `(no lines match ${JSON.stringify(pat)})`;
  }
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[... ${out.length} chars, truncated to ${maxChars}; narrow with grep ...]`;
  return { ok: true, text: out };
}

export const _internals = { headTailPreview, storeDir, DEFAULT_LIMIT };
