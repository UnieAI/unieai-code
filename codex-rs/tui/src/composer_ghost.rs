//! Ghost next-sentence derivation for the composer input.
//!
//! After a turn ends the engine may predict the user's likely next sentence.
//! That prediction is shown as dim "ghost" text in the (usually empty) input
//! box; pressing Tab / Right accepts it. The core rule from the `tui-composer`
//! spec is that **visibility is derived every frame from the current text — there
//! is no state machine**:
//!
//! * empty input                → show the whole prediction,
//! * input is a prefix of pred. → show only the remaining suffix (so typing that
//!   matches *shortens* the ghost),
//! * input diverges from pred.  → hide the ghost entirely.
//!
//! Accepting is just "input becomes input + ghost"; [`accept_ghost`] returns that
//! combined string.
//!
//! This module is the **pure, self-contained** core of the feature: it depends on
//! no codex TUI internal types and unit-tests in isolation. Wiring it into the
//! live composer render / key handling (drawing the dim run, binding Tab/Right,
//! sourcing the prediction from the model) is a deferred follow-up, so the public
//! surface below currently has only test consumers.
#![allow(dead_code)]

/// The remaining, not-yet-typed tail of `prediction` given the current `input`,
/// or `None` when no ghost should be shown this frame.
///
/// Matching is case-insensitive over ASCII (a user typing `let` still matches a
/// `Let` prediction). ASCII case folding preserves byte length and non-ASCII
/// bytes are compared verbatim, so slicing `prediction` by `input.len()` stays on
/// a valid char boundary whenever the prefix matches.
///
/// Returns `None` when:
/// * `prediction` is empty (nothing to suggest),
/// * `input` is longer than `prediction` (can't be a prefix),
/// * `input` and `prediction` diverge before `input` ends, or
/// * `input` already equals the whole prediction (the ghost is fully consumed).
pub(crate) fn ghost_suffix<'a>(input: &str, prediction: &'a str) -> Option<&'a str> {
    if prediction.is_empty() {
        return None;
    }
    if input.is_empty() {
        return Some(prediction);
    }
    if input.len() > prediction.len() {
        return None;
    }
    // `get` yields `None` if `input.len()` is not a char boundary in `prediction`.
    let head = prediction.get(..input.len())?;
    if !head.eq_ignore_ascii_case(input) {
        return None;
    }
    let tail = &prediction[input.len()..];
    if tail.is_empty() { None } else { Some(tail) }
}

/// Whether a ghost suffix is visible this frame for the given `input`.
pub(crate) fn ghost_visible(input: &str, prediction: &str) -> bool {
    ghost_suffix(input, prediction).is_some()
}

/// The text the composer should hold after the user accepts the ghost with
/// Tab / Right: `input` concatenated with the currently visible suffix.
///
/// Returns `None` when there is no ghost to accept (so the caller can let the
/// key fall through to its normal behavior).
pub(crate) fn accept_ghost(input: &str, prediction: &str) -> Option<String> {
    let suffix = ghost_suffix(input, prediction)?;
    let mut accepted = String::with_capacity(input.len() + suffix.len());
    accepted.push_str(input);
    accepted.push_str(suffix);
    Some(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_shows_full_prediction() {
        assert_eq!(ghost_suffix("", "run the tests"), Some("run the tests"));
        assert!(ghost_visible("", "run the tests"));
    }

    #[test]
    fn empty_prediction_is_never_visible() {
        assert_eq!(ghost_suffix("", ""), None);
        assert_eq!(ghost_suffix("anything", ""), None);
        assert!(!ghost_visible("x", ""));
    }

    #[test]
    fn matching_prefix_shortens_the_ghost() {
        // Typing characters that match the prediction shrinks the remaining tail.
        assert_eq!(ghost_suffix("run", "run the tests"), Some(" the tests"));
        assert_eq!(ghost_suffix("run the ", "run the tests"), Some("tests"));
    }

    #[test]
    fn prefix_match_is_ascii_case_insensitive() {
        assert_eq!(ghost_suffix("Run", "run the tests"), Some(" the tests"));
        assert_eq!(ghost_suffix("RUN THE ", "run the tests"), Some("tests"));
        // The returned suffix preserves the *prediction's* original casing.
        assert_eq!(ghost_suffix("r", "Run"), Some("un"));
    }

    #[test]
    fn divergence_hides_the_ghost() {
        assert_eq!(ghost_suffix("runx", "run the tests"), None);
        assert_eq!(ghost_suffix("walk", "run the tests"), None);
        assert!(!ghost_visible("walk", "run the tests"));
    }

    #[test]
    fn fully_typed_prediction_hides_the_ghost() {
        // Input equals the whole prediction: nothing left to suggest.
        assert_eq!(ghost_suffix("run the tests", "run the tests"), None);
        // Longer than the prediction can't be a prefix.
        assert_eq!(ghost_suffix("run the tests!", "run the tests"), None);
    }

    #[test]
    fn accept_combines_input_and_suffix() {
        assert_eq!(
            accept_ghost("run", "run the tests").as_deref(),
            Some("run the tests")
        );
        assert_eq!(
            accept_ghost("", "run the tests").as_deref(),
            Some("run the tests")
        );
        // Accepting preserves the exact typed prefix, adopting prediction casing
        // only for the suffix.
        assert_eq!(
            accept_ghost("RUN", "run the tests").as_deref(),
            Some("RUN the tests")
        );
    }

    #[test]
    fn accept_returns_none_when_no_ghost() {
        assert_eq!(accept_ghost("walk", "run the tests"), None);
        assert_eq!(accept_ghost("run the tests", "run the tests"), None);
    }

    #[test]
    fn non_ascii_prediction_stays_on_char_boundaries() {
        // Multi-byte prefix that matches: slice must not split a codepoint.
        assert_eq!(ghost_suffix("café ", "café latte"), Some("latte"));
        assert_eq!(ghost_suffix("café", "café latte"), Some(" latte"));
        // A byte length that lands mid-codepoint of the prediction returns None
        // rather than panicking: "é" occupies bytes 0..2 of the prediction, so a
        // 1-byte `input` splits it and the boundary check rejects the slice.
        assert_eq!(ghost_suffix("a", "ément"), None);
    }
}
