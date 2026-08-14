//! The skeptic: one model call judging the diff against the task, plus the two
//! guards that stop it turning into nagging.
//!
//! Ported from the JS reference implementation. The four criteria are not
//! generic code-review advice — each one is a failure mode that was observed and
//! then written down.

/// Consecutive failed reviews before the nudge escalates to strategist tone.
pub const STRATEGIST_THRESHOLD: u32 = 3;

pub const SYSTEM_PROMPT: &str = "You are a skeptical senior reviewer. Judge STRICTLY whether the diff fully addresses the task:
1. LITERALS: if the task quotes an exact expected output/message/format (error string, printed repr, serialized form, LaTeX/code output), verify the diff produces that EXACT literal — case, braces, quoting, spacing. Near-miss output is a gap.
2. SIBLINGS: other code paths with the same flaw (the next line, the reverse branch, other entry points/overloads/callers, init vs update paths) must be fixed too — an identical unfixed pattern adjacent to the edit is a gap.
3. EXCEPTIONS: error types callers/tests expect (input validation raises ValueError/TypeError — `assert` is a gap; returning the wrong exception type from a deeper layer is a gap).
4. REGRESSIONS: module-level imports that could be circular, API signatures changed under existing callers, behavior changes that break the unchanged default path.
Reply with exactly \"ACHIEVED\" if complete; otherwise list the concrete gaps (max 5 short bullets, each actionable, no preamble).";

/// When the skeptic is worth its cost.
///
/// `Nudged` is the default, and it is derived from measurement rather than
/// taste: on SWE-bench Verified the review is worth +7 on a model that ends 71%
/// of turns empty-handed, and −3 on one that ends 1% of them that way. The
/// difference is not the model's intelligence, it is whether the turn needed
/// pushing. A model that produced a coherent diff unprompted, and passed the
/// syntax and import gates, has already shown the behaviour the review looks
/// for; asking a mid-quality reviewer to find fault with it mostly produces
/// false positives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SkepticMode {
    /// Review every turn that changed something.
    Always,
    /// Review only a turn that had to be pushed, or one the gates flagged.
    #[default]
    Nudged,
    /// Deterministic gates only.
    Never,
}

impl SkepticMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "always" => Self::Always,
            "never" => Self::Never,
            _ => Self::Nudged,
        }
    }

    pub fn should_review(self, was_nudged: bool, gates_flagged: bool) -> bool {
        match self {
            Self::Always => true,
            Self::Never => false,
            Self::Nudged => was_nudged || gates_flagged,
        }
    }
}

/// True when the verdict is an acceptance rather than a gap list.
pub fn is_achieved(text: &str) -> bool {
    let cleaned = text.trim_start_matches(['*', '#', ' ', '\t', '\n']);
    cleaned
        .get(..8)
        .map(|s| s.eq_ignore_ascii_case("achieved"))
        .unwrap_or(false)
}

/// Normalise one gap bullet so the same complaint phrased differently still
/// matches: drop the marker, lowercase, strip line references, code spans,
/// numbers and punctuation, collapse whitespace.
fn normalize_bullet(line: &str) -> String {
    let mut s: String = line
        .trim_start_matches([' ', '\t', '>', '*', '-', '–', '—', '•'])
        .to_ascii_lowercase();

    // "1. " / "2) " list numbering
    if let Some(rest) = s.strip_prefix(|c: char| c.is_ascii_digit()) {
        let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        if let Some(r) = rest.strip_prefix(['.', ')']) {
            s = r.trim_start().to_string();
        }
    }

    // Inline code spans: paths and symbols get phrased differently run to run.
    let mut out = String::with_capacity(s.len());
    let mut in_code = false;
    for ch in s.chars() {
        if ch == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if in_code {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }

    // Digits (line numbers and anything else volatile) and punctuation.
    let out: String = out
        .chars()
        .map(|c| {
            if c.is_alphanumeric() && !c.is_numeric() {
                c
            } else if c.is_whitespace() {
                ' '
            } else {
                ' '
            }
        })
        .collect();

    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Fingerprint a gap list, insensitive to ordering, numbering and whitespace.
///
/// Empty input, or input with nothing substantial in it, yields an empty
/// fingerprint — which must never match a real one.
pub fn fingerprint_gaps(text: &str) -> String {
    let mut bullets: Vec<String> = text
        .lines()
        .map(normalize_bullet)
        .filter(|b| b.chars().count() >= 4)
        .collect();
    if bullets.is_empty() {
        return String::new();
    }
    bullets.sort();
    bullets.dedup();
    bullets.join("\n")
}

/// Choose the nudge for this round.
pub fn build_nudge(consecutive_not_achieved: u32, gap_text: &str) -> String {
    let gaps = gap_text.trim();
    if consecutive_not_achieved >= STRATEGIST_THRESHOLD {
        return format!(
            "[verification] This task has now failed review {consecutive_not_achieved} times in a row. \
Stop applying incremental patches — step back and reconsider your WHOLE approach. Either \
(a) restructure the solution decisively to address the recurring problem, or (b) if it \
genuinely cannot be done, stop and explain precisely why. Do not submit another small fix \
without a changed strategy.\n\nOutstanding gaps:\n{gaps}"
        );
    }
    format!(
        "[verification] A skeptical review of your diff found gaps:\n{gaps}\nAddress each gap now by editing the code (or state precisely why a gap does not apply), then finish."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn achieved_is_recognised_through_decoration() {
        assert!(is_achieved("ACHIEVED"));
        assert!(is_achieved("achieved"));
        assert!(is_achieved("**ACHIEVED**"));
        assert!(is_achieved("## Achieved\n"));
        assert!(!is_achieved("- the sibling path still returns 1"));
        assert!(!is_achieved(""));
    }

    #[test]
    fn fingerprint_ignores_ordering_numbering_and_line_refs() {
        let a = "- the sibling at line 42 still returns 1\n- `foo.py` raises the wrong type";
        let b = "2) `bar.py` raises the wrong type\n1. the sibling at line 7 still returns 1";
        assert_eq!(fingerprint_gaps(a), fingerprint_gaps(b));
    }

    #[test]
    fn an_empty_fingerprint_never_matches() {
        // Otherwise a review that said nothing would look like a repeat of the
        // previous one and silently disable the stall exit.
        assert_eq!(fingerprint_gaps(""), "");
        assert_eq!(fingerprint_gaps("ok"), "");
        assert_ne!(fingerprint_gaps("- a real and specific gap"), "");
    }

    #[test]
    fn the_ladder_changes_tone_at_the_threshold() {
        assert!(build_nudge(1, "- gap").contains("skeptical review"));
        assert!(build_nudge(2, "- gap").contains("skeptical review"));
        let third = build_nudge(3, "- gap");
        assert!(third.contains("reconsider your WHOLE approach"));
        assert!(third.contains("3 times in a row"));
    }

    #[test]
    fn modes_decide_who_gets_reviewed() {
        assert!(SkepticMode::Always.should_review(false, false));
        assert!(!SkepticMode::Never.should_review(true, true));
        // The default spends the review only where it was measured to pay.
        assert!(!SkepticMode::Nudged.should_review(false, false));
        assert!(SkepticMode::Nudged.should_review(true, false));
        assert!(SkepticMode::Nudged.should_review(false, true));
        assert_eq!(SkepticMode::parse("ALWAYS"), SkepticMode::Always);
        assert_eq!(SkepticMode::parse("garbage"), SkepticMode::Nudged);
    }
}
