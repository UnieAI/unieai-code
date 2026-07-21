/**
 * completion-escalation.mjs — escalate the completion verifier's nudge when the
 * same task keeps failing review (idea from grok-build's goal strategist / stop-
 * drift ladder). The plain nudge lists the gaps and says "fix them"; after the
 * task has failed verification enough times in a row, that clearly isn't working,
 * so we switch to a STRATEGIST nudge that tells the model to stop patching and
 * reconsider its whole approach. Complements the gap-fingerprint stall exit:
 * that stops re-nudging on IDENTICAL gaps; this escalates on PERSISTENT failure
 * even when the gaps drift.
 *
 * Pure and dependency-free.
 */

// Consecutive failed reviews before the nudge escalates to strategist tone.
export const STRATEGIST_THRESHOLD = 3;

/**
 * Choose the verification nudge for this round.
 * @param {object} p
 * @param {number} p.consecutiveNotAchieved  failed reviews in a row (this round included)
 * @param {string} p.gapText                 the verifier's gap list
 * @param {number} [p.threshold]
 * @returns {string}
 */
export function buildNudge({ consecutiveNotAchieved, gapText, threshold = STRATEGIST_THRESHOLD }) {
  const gaps = String(gapText || "").trim();
  if (consecutiveNotAchieved >= threshold) {
    return (
      `[verification] This task has now failed review ${consecutiveNotAchieved} times in a row. ` +
      "Stop applying incremental patches — step back and reconsider your WHOLE approach. Either " +
      "(a) restructure the solution decisively to address the recurring problem, or (b) if it " +
      "genuinely cannot be done, stop and explain precisely why. Do not submit another small fix " +
      "without a changed strategy.\n\nOutstanding gaps:\n" +
      gaps
    );
  }
  return (
    "[verification] A skeptical review of your diff found gaps:\n" +
    gaps +
    "\nAddress each gap now by editing the code (or state precisely why a gap does not apply), then finish."
  );
}

/** True once persistent failure has reached the strategist threshold. */
export function isStrategistPhase(consecutiveNotAchieved, threshold = STRATEGIST_THRESHOLD) {
  return Number(consecutiveNotAchieved) >= threshold;
}
