// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

#[test]
fn declared_wins_then_learned_then_the_fallback() {
    let mut learned = HashMap::new();
    learned.insert("flash".to_string(), 131_072);
    assert_eq!(
        resolve_context_window(Some(262_144), &learned, "flash"),
        Some(262_144)
    );
    assert_eq!(
        resolve_context_window(None, &learned, "flash"),
        Some(131_072)
    );
    assert_eq!(
        resolve_context_window(None, &learned, "other"),
        Some(UNIEAI_FALLBACK_CONTEXT_WINDOW)
    );
    assert_eq!(
        resolve_context_window(Some(0), &learned, "other"),
        Some(UNIEAI_FALLBACK_CONTEXT_WINDOW),
        "a zero window is 'not recorded', not a window"
    );
}

#[test]
fn record_keeps_the_smallest_rejection_and_ignores_nonsense() {
    let home = tempfile::tempdir().expect("tempdir");
    record(home.path(), "flash", 131_072).expect("record");
    record(home.path(), "flash", 200_000).expect("record");
    assert_eq!(load(home.path()).get("flash"), Some(&131_072));

    record(home.path(), "flash", 64_000).expect("record");
    assert_eq!(load(home.path()).get("flash"), Some(&64_000));

    record(home.path(), "flash", 12).expect("record");
    record(home.path(), "", 100_000).expect("record");
    let limits = load(home.path());
    assert_eq!(limits.get("flash"), Some(&64_000));
    assert_eq!(limits.len(), 1);
}

#[test]
fn a_missing_or_broken_file_reads_as_nothing_learned() {
    let home = tempfile::tempdir().expect("tempdir");
    assert!(load(home.path()).is_empty());
    std::fs::write(limits_path(home.path()), "not json").expect("write");
    assert!(load(home.path()).is_empty());
}
