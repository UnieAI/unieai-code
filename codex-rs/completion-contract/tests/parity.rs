//! The Rust port must behave like the JS reference implementation, because the
//! SWE-bench numbers were measured with that one. These pin the decisions a
//! reader would otherwise have to take on trust.
//!
//! Deliberately end-to-end over a real temporary git repository: the gates read
//! the workspace through `git`, and mocking that would test the mock.

use codex_completion_contract::ContractState;
use codex_completion_contract::NO_MUTATION_NUDGE;
use codex_completion_contract::SkepticMode;
use codex_completion_contract::Turn;
use codex_completion_contract::Verdict;
use codex_completion_contract::evaluate;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("git should run");
    assert!(status.status.success(), "git {args:?} failed");
}

/// A committed repository with one tracked file.
fn repo(content: &str) -> TempDir {
    let dir = TempDir::new().expect("tempdir");
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["config", "user.email", "t@example.com"]);
    git(dir.path(), &["config", "user.name", "t"]);
    std::fs::write(dir.path().join("a.py"), content).expect("write");
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "base"]);
    dir
}

fn never_review(_: &str, _: &str) -> Option<String> {
    panic!("the skeptic should not have been called");
}

fn turn<'a>(dir: &'a TempDir, was_nudged: bool) -> Turn<'a> {
    Turn {
        workspace: dir.path(),
        task: "fix the bug",
        answer_text: "did it",
        was_nudged,
    }
}

#[test]
fn a_turn_that_changed_nothing_is_blocked() {
    let dir = repo("def f():\n    return 1\n");
    let mut state = ContractState::default();
    let verdict = evaluate(&turn(&dir, false), &mut state, SkepticMode::Nudged, never_review);
    assert_eq!(verdict, Verdict::Block(NO_MUTATION_NUDGE.to_string()));
}

#[test]
fn the_no_mutation_nudge_leaves_an_escape_hatch() {
    // Without this a genuine "just tell me what you would change" request becomes
    // unanswerable, and the gate forces edits for their own sake.
    assert!(NO_MUTATION_NUDGE.contains("state explicitly why"));
}

#[test]
fn a_broken_change_is_caught_before_any_model_is_called() {
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def broken(\n").expect("write");
    let mut state = ContractState::default();
    match evaluate(&turn(&dir, false), &mut state, SkepticMode::Nudged, never_review) {
        Verdict::Block(reason) => assert!(reason.contains("fails to compile"), "{reason}"),
        Verdict::Allow => panic!("a file that does not compile was allowed through"),
    }
}

#[test]
fn the_deterministic_gates_speak_once_not_every_round() {
    // Repeating them turns a nudge into nagging; the model has already seen them.
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def broken(\n").expect("write");
    let mut state = ContractState::default();
    let first = evaluate(&turn(&dir, false), &mut state, SkepticMode::Nudged, never_review);
    assert!(matches!(first, Verdict::Block(_)));
    // Second round: gates already ran, and the turn was flagged so the skeptic
    // is now in scope — it must be the reviewer speaking, not the gates again.
    let second = evaluate(&turn(&dir, false), &mut state, SkepticMode::Nudged, |_, _| {
        Some("ACHIEVED".to_string())
    });
    assert_eq!(second, Verdict::Allow);
}

#[test]
fn a_turn_that_acted_unprompted_is_not_reviewed() {
    // The adaptive default. On DeepSeek this is almost every turn, which is what
    // turned a 3-point loss into a 1-point gain.
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def f():\n    return 2\n").expect("write");
    let mut state = ContractState::default();
    let verdict = evaluate(&turn(&dir, false), &mut state, SkepticMode::Nudged, never_review);
    assert_eq!(verdict, Verdict::Allow);
    assert!(state.skeptic_skipped, "skipped must be distinguishable from found-nothing");
    assert!(!state.skeptic_ran);
}

#[test]
fn a_turn_that_had_to_be_pushed_is_reviewed() {
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def f():\n    return 2\n").expect("write");
    let mut state = ContractState::default();
    let verdict = evaluate(&turn(&dir, true), &mut state, SkepticMode::Nudged, |_, user| {
        // The reviewer must see the task, the diff and what the model claimed.
        assert!(user.contains("fix the bug"), "task missing");
        assert!(user.contains("Workspace diff"), "diff missing");
        assert!(user.contains("did it"), "agent report missing");
        Some("- the sibling path still returns 1".to_string())
    });
    match verdict {
        Verdict::Block(reason) => assert!(reason.contains("sibling path still returns 1")),
        Verdict::Allow => panic!("a reviewed turn with gaps was allowed through"),
    }
}

#[test]
fn an_untracked_only_turn_is_still_reviewed() {
    // `git diff` shows tracked edits only, so a turn whose whole output was a new
    // repro script used to pass the mutation gate and skip the review entirely.
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("repro.py"), "print('repro')\n").expect("write");
    let mut state = ContractState::default();
    let mut saw_untracked = false;
    let verdict = evaluate(&turn(&dir, true), &mut state, SkepticMode::Nudged, |_, user| {
        saw_untracked = user.contains("repro.py");
        Some("ACHIEVED".to_string())
    });
    assert_eq!(verdict, Verdict::Allow);
    assert!(saw_untracked, "the reviewer never saw the untracked file");
}

#[test]
fn the_same_gaps_twice_running_stop_the_nudging() {
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def f():\n    return 2\n").expect("write");
    let gaps = "- the sibling path still returns 1";
    let mut state = ContractState::default();

    let first = evaluate(&turn(&dir, true), &mut state, SkepticMode::Nudged, |_, _| {
        Some(gaps.to_string())
    });
    assert!(matches!(first, Verdict::Block(_)), "the first round should nudge");

    state.skeptic_ran = false; // a fresh turn, same session
    let second = evaluate(&turn(&dir, true), &mut state, SkepticMode::Nudged, |_, _| {
        Some(gaps.to_string())
    });
    assert_eq!(second, Verdict::Allow, "an identical repeat should let the turn end");
}

#[test]
fn escalation_climbs_while_the_gaps_keep_changing() {
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def f():\n    return 2\n").expect("write");
    let mut state = ContractState::default();
    let mut round = |gaps: &str, state: &mut ContractState| {
        state.skeptic_ran = false;
        evaluate(&turn(&dir, true), state, SkepticMode::Nudged, |_, _| Some(gaps.to_string()))
    };
    round("- gap one", &mut state);
    round("- gap two", &mut state);
    let third = round("- gap three", &mut state);
    assert_eq!(state.consecutive_not_achieved, 3);
    match third {
        Verdict::Block(reason) => assert!(
            reason.contains("reconsider your WHOLE approach"),
            "the ladder never reached the strategist rung: {reason}"
        ),
        Verdict::Allow => panic!("the third distinct failure was allowed through"),
    }
}

// ── failing open ─────────────────────────────────────────────────────────────

#[test]
fn a_directory_that_is_not_a_repository_lets_the_turn_end() {
    let dir = TempDir::new().expect("tempdir");
    let mut state = ContractState::default();
    let verdict = evaluate(
        &Turn { workspace: dir.path(), task: "t", answer_text: "", was_nudged: true },
        &mut state,
        SkepticMode::Nudged,
        never_review,
    );
    assert_eq!(verdict, Verdict::Allow);
}

#[test]
fn a_reviewer_that_cannot_answer_lets_the_turn_end() {
    // Refusing to finish because the verifier is broken is strictly worse than
    // finishing unverified.
    let dir = repo("def f():\n    return 1\n");
    std::fs::write(dir.path().join("a.py"), "def f():\n    return 2\n").expect("write");
    for answer in [None, Some(String::new()), Some("ACHIEVED".to_string())] {
        let mut state = ContractState::default();
        let verdict = evaluate(&turn(&dir, true), &mut state, SkepticMode::Nudged, |_, _| answer.clone());
        assert_eq!(verdict, Verdict::Allow, "answer {answer:?} should not block");
    }
}
