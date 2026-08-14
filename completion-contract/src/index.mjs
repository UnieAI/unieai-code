/**
 * completion-contract — refuse to let a coding turn end while the work is
 * visibly unfinished.
 *
 * This is the one mechanism in this repo that is ours and that was measured:
 * on SWE-bench Verified with a weak model (Qwen3.6-35B-A3B) it moved 20% → 46%,
 * almost entirely by collapsing the empty-handed rate (71% → 13%) — the model
 * analysed the problem and stopped without touching a file. On a strong model
 * the same gates are close to neutral. Everything else that grew up around it
 * was a reimplementation of things codex already does better.
 *
 * It is deliberately host-agnostic. The only thing it cannot do by itself is
 * call a model, so the caller injects that:
 *
 *   · as a codex `Stop` hook   — bin/stop-hook.mjs, `{decision:"block",reason}`
 *   · as agent-core's          — ctx.completionCheck(...)
 *
 * Same code, same thresholds, two hosts. The gates below only ever look at the
 * workspace through `git` and `python3`, so nothing here knows which loop is
 * driving it.
 */

import { deterministicGates, staticDiffChecks, untrackedDigest } from "./gates.mjs";
import { buildNudge } from "./escalation.mjs";
import { fingerprintGaps, isRepeatedStall } from "./gap-fingerprint.mjs";
import { spawnSync } from "node:child_process";

const MID = (s, max) => (s.length <= max ? s : `${s.slice(0, max / 2)}\n[...truncated...]\n${s.slice(-max / 2)}`);

/** The nudge for a turn that claims to be done without touching anything. */
export const NO_MUTATION_NUDGE =
  "No files in the workspace have been modified. If the task requires changes, " +
  "make them now with the edit/write tools and verify them. If you are certain no " +
  "change is needed, state explicitly why.";

export const SKEPTIC_SYSTEM =
  "You are a skeptical senior reviewer. Judge STRICTLY whether the diff fully addresses the task:\n" +
  "1. LITERALS: if the task quotes an exact expected output/message/format (error string, printed repr, " +
  "serialized form, LaTeX/code output), verify the diff produces that EXACT literal — case, braces, " +
  "quoting, spacing. Near-miss output is a gap.\n" +
  "2. SIBLINGS: other code paths with the same flaw (the next line, the reverse branch, other entry " +
  "points/overloads/callers, init vs update paths) must be fixed too — an identical unfixed pattern " +
  "adjacent to the edit is a gap.\n" +
  "3. EXCEPTIONS: error types callers/tests expect (input validation raises ValueError/TypeError — " +
  "`assert` is a gap; returning the wrong exception type from a deeper layer is a gap).\n" +
  "4. REGRESSIONS: module-level imports that could be circular, API signatures changed under existing " +
  'callers, behavior changes that break the unchanged default path.\n' +
  'Reply with exactly "ACHIEVED" if complete; otherwise list the concrete gaps (max 5 short bullets, each actionable, no preamble).';

/**
 * Build the contract.
 *
 * @param {object} p
 * @param {string} p.workspace  absolute path to the repo under work
 * @param {(p:{system:string,user:string})=>Promise<string>} p.callModel
 *   the skeptic's one model call. Injected because that is the only thing a
 *   host has to supply — everything else is `git` and the filesystem.
 * @param {object} [p.state]  carried ACROSS turns by the caller (the escalation
 *   ladder and the once-per-turn flags live here). A codex hook persists it to
 *   a file keyed by session; an in-process host keeps it in the session object.
 * @returns {(p:{task:string, answerText?:string}) => Promise<string|null>}
 *   the nudge to send back, or null to let the turn end.
 */
/**
 * When the skeptic is worth its cost.
 *
 *   "always"  — review every turn that changed something.
 *   "nudged"  — review only a turn that had to be pushed to get here (DEFAULT).
 *   "never"   — deterministic gates only.
 *
 * "nudged" is derived from measurement, not taste. On SWE-bench Verified the
 * skeptic is worth +8 on a model that is empty-handed 71% of the time, and −3
 * on one that is empty-handed 1% of the time. The difference is not the model's
 * intelligence, it is whether the turn needed pushing: a model that produced a
 * coherent diff unprompted, and passed the syntax and import gates, has already
 * shown the behaviour the review is looking for. Asking a mid-quality reviewer
 * to find fault with it mostly produces false positives — the runs are full of
 * the model correctly rebutting "sibling" gaps that were surface string matches
 * in unrelated classes.
 */
export const SKEPTIC_MODES = ["always", "nudged", "never"];

export function createCompletionContract({ workspace, callModel, state = {}, skepticMode = "nudged" }) {
  return async function check({ task, answerText = "", wasNudged = false }) {
    const st = spawnSync("git", ["-C", workspace, "status", "--porcelain"], { encoding: "utf8", timeout: 10000 });
    // Not a git repo, or git is broken: we cannot tell whether anything
    // happened, and blocking a turn on a fact we do not have is worse than
    // letting it end.
    if (st.status !== 0) return null;

    // Gate 1 — the mutation gate. The single highest-value check: a turn that
    // claims to be finished having changed nothing at all.
    if (String(st.stdout || "").trim().length === 0) return NO_MUTATION_NUDGE;

    // Gate 2 — deterministic checks on what changed. One round only: repeating
    // them turns a nudge into nagging, and the model has already seen them.
    if (!state.gatesRan) {
      state.gatesRan = true;
      try {
        const problems = [...(deterministicGates(workspace) || []), ...staticDiffChecks(workspace, task)];
        if (problems.length) {
          state.gatesFlagged = true;
          return (
            "[verification] Automatic checks on your changes found issues:\n\n- " +
            problems.join("\n- ") +
            "\n\nAddress each one now (fix it, or state precisely why it does not apply), then finish."
          );
        }
      } catch {
        // Gates are best-effort. A broken python3 must not block a turn.
      }
    }

    // Gate 3 — the skeptic. Once per turn, only when something changed, and
    // only when this turn is one the review is likely to help.
    if (state.skepticRan) return null;
    if (skepticMode === "never") return null;
    if (skepticMode === "nudged" && !wasNudged && !state.gatesFlagged) {
      // The model acted unprompted and the deterministic gates were happy.
      // Recorded so a caller can tell "skipped" from "found nothing".
      state.skepticSkipped = true;
      return null;
    }
    state.skepticRan = true;

    const diff = spawnSync("git", ["-C", workspace, "diff"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.status !== 0) return null;
    // `git diff` shows tracked edits only, so a turn whose only output was a new
    // untracked file (a repro script, most often) would otherwise reach here
    // with an empty diff and skip verification entirely — while the mutation
    // gate above had already passed it.
    const diffText = String(diff.stdout || "") + untrackedDigest(workspace, st.stdout);
    if (!diffText.trim()) return null;

    let verdict = "";
    try {
      verdict = await callModel({
        system: SKEPTIC_SYSTEM,
        user: `## Task\n${MID(String(task || ""), 3000)}\n\n## Workspace diff\n${MID(diffText, 6000)}\n\n## Agent's final report\n${MID(String(answerText || ""), 1500)}`,
      });
    } catch {
      return null; // a verifier that cannot run must not hold the turn hostage
    }

    const text = String(verdict || "").trim();
    if (!text || /^achieved\b/i.test(text.replace(/^[*#\s]+/, ""))) {
      state.consecutiveNotAchieved = 0;
      return null;
    }

    // Stall exit: if this turn's gaps match the previous turn's, re-nudging only
    // spins on the same blocker — accept the turn and let the next one (or the
    // user) take over. Argument order is (previous, new); getting it backwards
    // silently disables the exit.
    const fp = fingerprintGaps(text);
    if (isRepeatedStall(state.lastGapFingerprint, fp)) {
      state.lastGapFingerprint = fp;
      return null;
    }
    state.lastGapFingerprint = fp;
    // Strategist escalation: the gaps DIFFER from last turn but the task keeps
    // failing review — after enough rounds, stop asking for small fixes and tell
    // the model to reconsider its whole approach.
    state.consecutiveNotAchieved = (state.consecutiveNotAchieved || 0) + 1;
    return buildNudge({ consecutiveNotAchieved: state.consecutiveNotAchieved, gapText: MID(text, 1500) });
  };
}

export { deterministicGates, staticDiffChecks, untrackedDigest } from "./gates.mjs";
export { buildNudge } from "./escalation.mjs";
