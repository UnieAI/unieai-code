/**
 * goal-summarizer.mjs — pure helpers for the achievement-triggered closing
 * summary (goal-harness §4.2, translated from grok-build's goal_summarizer
 * IDEAS, NOT its read-only subagent). When a mutation turn is judged ACHIEVED,
 * the engine fires ONE small model call (fail-open, off any hot path) to produce
 * a concise "here's what I accomplished" note — files changed + what/why — and
 * surfaces it without blocking completion.
 *
 * This module holds only the PURE parts: assembling the model prompt, parsing
 * the changed-file list out of `git status --porcelain`, and clamping the
 * model's output. The one model call itself lives in engine.mjs.
 */

/** Hard char backstop on the surfaced summary (mirrors grok's 1200-char cap). */
export const SUMMARY_MAX_CHARS = 1200;

/**
 * Changed file paths from `git status --porcelain` output. Handles rename
 * entries (`R  old -> new` → new path) and ignores blank lines. Pure.
 * @param {string} porcelain
 * @returns {string[]}
 */
export function changedFilesFromStatus(porcelain) {
  const out = [];
  for (const line of String(porcelain || "").split("\n")) {
    if (line.trim().length === 0) continue;
    // Porcelain v1: 2 status chars + a space, then the path (or "old -> new").
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4).trim();
    // Strip surrounding quotes git adds for paths with special chars.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) out.push(path);
  }
  return out;
}

/**
 * Assemble the summarizer model prompt from the task, changed files, and diff.
 * Returns { system, user } for callModelJson. Inputs are capped so a huge diff
 * can't blow up the aux call. Pure.
 */
export function buildSummaryRequest({ task, files = [], diff = "", maxDiff = 6000, maxTask = 2000 } = {}) {
  const fileList = files.length ? files.map((f) => `- ${f}`).join("\n") : "(none reported)";
  return {
    system:
      "You are writing the CLOSING summary of a just-completed coding task, for the user to read last. " +
      "State plainly what was accomplished: the files changed and, for each meaningful change, WHAT changed " +
      "and WHY. Be concrete and honest — do not claim anything the diff does not show. " +
      "HARD LIMIT: 80 words, at most 4 bullets. No preamble, no restating the task, no next-steps.",
    user:
      `## Task\n${String(task || "").slice(0, maxTask)}\n\n` +
      `## Files changed\n${fileList}\n\n` +
      `## Diff\n${String(diff || "").slice(0, maxDiff)}`,
  };
}

/**
 * Normalize the model's summary output: trim, drop to "" when empty, and clamp
 * to SUMMARY_MAX_CHARS with a truncation marker. Pure.
 * @returns {string} "" when there is nothing usable.
 */
export function clampSummary(raw, { maxChars = SUMMARY_MAX_CHARS } = {}) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + " […]";
}
