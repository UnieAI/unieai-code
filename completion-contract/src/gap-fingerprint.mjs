/**
 * gap-fingerprint.mjs — detect when a verifier keeps raising the SAME gaps turn
 * after turn (idea from grok-build's goal_tracker gap-fingerprint stall exit).
 *
 * The completion verifier nudges the model with a list of gaps when a change is
 * incomplete. If the next turn's verification returns the same gaps, re-nudging
 * only spins — the model is stuck on a genuine blocker, not making progress. A
 * fingerprint that is insensitive to ordering, numbering, whitespace, and line
 * references lets the caller notice "these are the same gaps as last time" and
 * stop drifting instead of looping.
 *
 * Pure and dependency-free.
 */

/** Normalize one gap bullet: drop the marker/number, lowercase, strip volatile
 * bits (line numbers, quoted spans, punctuation), collapse whitespace. */
function normalizeBullet(line) {
  return String(line || "")
    .replace(/^[\s>*\-–—•]+/, "")            // list markers
    .replace(/^\d+[.)]\s*/, "")               // "1. " / "2) "
    .toLowerCase()
    .replace(/`[^`]*`/g, " ")                 // inline code spans (paths/symbols vary in phrasing)
    .replace(/\bline[s]?\s+[\d,\s]+/g, " ")   // "line 42", "lines 3, 7"
    .replace(/[0-9]+/g, " ")                   // any remaining numbers
    .replace(/[^\p{L}\p{N}\s]/gu, " ")        // punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fingerprint a verifier's gap text: split into bullet-ish lines, normalize each,
 * drop empties, dedupe, sort (order-insensitive), join. Returns "" for empty or
 * "achieved" input so an empty fingerprint never matches a real one.
 */
export function fingerprintGaps(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const bullets = raw
    .split("\n")
    .map(normalizeBullet)
    .filter((b) => b.length >= 4);
  if (bullets.length === 0) return "";
  return Array.from(new Set(bullets)).sort().join("\n");
}

/**
 * True when the new gaps are a non-empty repeat of the previous fingerprint —
 * the signal to stop re-nudging.
 */
export function isRepeatedStall(prevFingerprint, newFingerprint) {
  return Boolean(newFingerprint) && newFingerprint === prevFingerprint;
}

export const _internals = { normalizeBullet };
