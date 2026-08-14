//! Refuse to let a coding turn end while the work is visibly unfinished.
//!
//! A weak model's most common failure is not a wrong patch — it is no patch. On
//! SWE-bench Verified, Qwen3.6-35B-A3B ended 71 of 100 turns having changed
//! nothing: it analysed the problem, described the fix, and stopped. Three gates
//! at turn end took that model from 16 resolved to 45.
//!
//! Runs as a codex `Stop` hook, dispatched from argv like `apply_patch`
//! (see `codex-rs/arg0`). The hook reads `StopCommandInput` on stdin and answers
//! `{"decision":"block","reason":…}` to send the turn back, or `{}` to let it end.
//!
//! Everything fails OPEN. A hook that errors, cannot reach a model, or is
//! pointed at a directory that is not a repository lets the turn finish —
//! refusing to end a turn because the verifier is broken is strictly worse than
//! ending it unverified.

pub mod gates;
pub mod hook;
pub mod review;
pub mod skeptic;
pub mod state;

use std::path::Path;

pub use gates::mid;
pub use skeptic::SkepticMode;
pub use state::ContractState;

/// The nudge for a turn that claims to be done without touching anything.
///
/// The escape hatch at the end is load-bearing: a genuine "just tell me what you
/// would change" request must remain answerable, so the gate asks for an account
/// rather than an edit.
pub const NO_MUTATION_NUDGE: &str = "No files in the workspace have been modified. \
If the task requires changes, make them now with the edit/write tools and verify them. \
If you are certain no change is needed, state explicitly why.";

/// What a hook run decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Let the turn end.
    Allow,
    /// Send the turn back with this text.
    Block(String),
}

/// Everything one evaluation needs from its host.
pub struct Turn<'a> {
    pub workspace: &'a Path,
    pub task: &'a str,
    pub answer_text: &'a str,
    /// Did this turn already have to be pushed to get here?
    pub was_nudged: bool,
}

/// Run the contract.
///
/// `review` performs the skeptic's single model call and returns its verdict
/// text; it is injected because that is the only thing the contract cannot do
/// from `git` and the filesystem alone. Returning `None` means the review could
/// not run, which is treated as "no objection".
pub fn evaluate<F>(turn: &Turn<'_>, state: &mut ContractState, mode: SkepticMode, review: F) -> Verdict
where
    F: FnOnce(&str, &str) -> Option<String>,
{
    // Not a git repo, or git is broken: we cannot tell whether anything happened,
    // and blocking a turn on a fact we do not have is worse than letting it end.
    let Some(porcelain) = gates::status_porcelain(turn.workspace) else {
        return Verdict::Allow;
    };

    // Gate 1 — the mutation gate. The single highest-value check: a turn that
    // claims to be finished having changed nothing at all.
    if porcelain.trim().is_empty() {
        return Verdict::Block(NO_MUTATION_NUDGE.to_string());
    }

    // Gate 2 — deterministic checks on what changed. One round only: repeating
    // them turns a nudge into nagging, and the model has already seen them.
    if !state.gates_ran {
        state.gates_ran = true;
        let mut problems = gates::deterministic_gates(turn.workspace);
        problems.extend(gates::static_diff_checks(turn.workspace, turn.task));
        if !problems.is_empty() {
            state.gates_flagged = true;
            return Verdict::Block(format!(
                "[verification] Automatic checks on your changes found issues:\n\n- {}\n\nAddress each one now (fix it, or state precisely why it does not apply), then finish.",
                problems.join("\n- ")
            ));
        }
    }

    // Gate 3 — the skeptic. Once per turn, only when something changed, and only
    // when this turn is one the review is likely to help.
    if state.skeptic_ran {
        return Verdict::Allow;
    }
    if !mode.should_review(turn.was_nudged, state.gates_flagged) {
        // Recorded so a caller can tell "skipped by policy" from "found nothing".
        state.skeptic_skipped = true;
        return Verdict::Allow;
    }
    state.skeptic_ran = true;

    let Some(diff_text) = gates::diff(turn.workspace) else {
        return Verdict::Allow;
    };
    // `git diff` shows tracked edits only, so a turn whose only output was a new
    // untracked file — a repro script, most often — would otherwise reach here
    // with an empty diff and skip verification entirely, while the mutation gate
    // above had already passed it.
    let full_diff = format!(
        "{diff_text}{}",
        gates::untracked_digest(turn.workspace, &porcelain)
    );
    if full_diff.trim().is_empty() {
        return Verdict::Allow;
    }

    let user = format!(
        "## Task\n{}\n\n## Workspace diff\n{}\n\n## Agent's final report\n{}",
        mid(turn.task, 3000),
        mid(&full_diff, 6000),
        mid(turn.answer_text, 1500)
    );
    let Some(verdict) = review(skeptic::SYSTEM_PROMPT, &user) else {
        return Verdict::Allow; // a verifier that cannot run must not hold the turn hostage
    };

    let text = verdict.trim();
    if text.is_empty() || skeptic::is_achieved(text) {
        state.consecutive_not_achieved = 0;
        return Verdict::Allow;
    }

    // Stall exit: if this turn's gaps match the previous turn's, re-nudging only
    // spins on the same blocker — accept the turn and let the next one, or the
    // user, take over.
    let fingerprint = skeptic::fingerprint_gaps(text);
    if !fingerprint.is_empty() && state.last_gap_fingerprint.as_deref() == Some(&fingerprint) {
        state.last_gap_fingerprint = Some(fingerprint);
        return Verdict::Allow;
    }
    state.last_gap_fingerprint = Some(fingerprint);

    // Strategist escalation: the gaps DIFFER from last turn but the task keeps
    // failing review — after enough rounds, stop asking for small fixes and tell
    // the model to reconsider its whole approach.
    state.consecutive_not_achieved += 1;
    Verdict::Block(skeptic::build_nudge(
        state.consecutive_not_achieved,
        &mid(text, 1500),
    ))
}
