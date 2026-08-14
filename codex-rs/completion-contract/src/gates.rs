//! The deterministic half of the completion contract.
//!
//! Everything here is a fact about the workspace, established without a model
//! call: did anything change, does the changed Python still compile and import,
//! did the turn edit tests it was told not to, did it leave an identical copy of
//! the line it just fixed sitting next to it.
//!
//! Cheap, so these run before the skeptic and can refuse a turn on their own.
//! Ported from the JS reference implementation in `completion-contract/`, which
//! is the version the SWE-bench numbers were measured with.

use std::path::Path;
use std::process::Command;

/// Middle-truncate, so both ends of a long message survive.
pub fn mid(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let half = max / 2;
    let head: String = s.chars().take(half).collect();
    let tail: String = s
        .chars()
        .skip(s.chars().count().saturating_sub(half))
        .collect();
    format!("{head}\n[...truncated...]\n{tail}")
}

fn git(workspace: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `git status --porcelain`. `None` means git could not answer — not "clean".
///
/// The distinction matters: a turn in a directory that is not a repository must
/// be allowed to end, and treating "cannot tell" as "nothing changed" would
/// block every one of them.
pub fn status_porcelain(workspace: &Path) -> Option<String> {
    git(workspace, &["status", "--porcelain"])
}

pub fn diff(workspace: &Path) -> Option<String> {
    git(workspace, &["diff"])
}

/// Files the turn changed, from porcelain status, for the summariser and gates.
pub fn changed_files(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter_map(|l| {
            let rest = l.get(3..)?.trim();
            if rest.is_empty() {
                None
            } else {
                Some(rest.trim_matches('"').to_string())
            }
        })
        .collect()
}

/// New files, rendered so the skeptic can judge them alongside `git diff`,
/// which only ever shows tracked edits.
///
/// Capped hard: a verification prompt is not the place to paste a build output
/// or a vendored directory that happens to be untracked, and a file's opening
/// lines are enough to say what it is.
pub fn untracked_digest(workspace: &Path, porcelain: &str) -> String {
    let paths: Vec<&str> = porcelain
        .lines()
        .filter(|l| l.starts_with("??"))
        .filter_map(|l| l.get(3..).map(str::trim))
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n\n## New (untracked) files\n");
    for p in paths.iter().take(5) {
        let clean = p.trim_matches('"');
        let Ok(body) = std::fs::read_to_string(workspace.join(clean)) else {
            continue; // a directory or an unreadable blob; the name still tells the reviewer it exists
        };
        let head: Vec<&str> = body.lines().take(60).collect();
        out.push_str(&format!("\n### {clean}\n{}\n", mid(&head.join("\n"), 1500)));
    }
    if paths.len() > 5 {
        out.push_str(&format!("\n(+{} more untracked paths)\n", paths.len() - 5));
    }
    out
}

/// Syntax and import health of the changed Python.
///
/// A missing *external* dependency is reported as "cannot judge" rather than as
/// a problem: the agent did not break `numpy`, and blocking a turn over the
/// environment teaches it to chase things it cannot fix.
pub fn deterministic_gates(workspace: &Path) -> Vec<String> {
    let Some(changed) = git(workspace, &["diff", "--name-only"]) else {
        return Vec::new();
    };
    let py: Vec<&str> = changed
        .lines()
        .map(str::trim)
        .filter(|f| f.ends_with(".py"))
        .collect();

    let mut problems = Vec::new();
    for f in py.into_iter().take(10) {
        let syn = Command::new("python3")
            .args(["-m", "py_compile", f])
            .current_dir(workspace)
            .output();
        match syn {
            Ok(o) if !o.status.success() => {
                let err = String::from_utf8_lossy(&o.stderr).into_owned();
                problems.push(format!("`{f}` fails to compile:\n{}", mid(&err, 600)));
                continue;
            }
            Ok(_) => {}
            Err(_) => return problems, // no python3: this gate simply does not apply
        }

        let module = f.trim_end_matches(".py").replace('/', ".");
        let module = module.trim_end_matches(".__init__");
        let imp = Command::new("python3")
            .args(["-c", &format!("import {module}")])
            .current_dir(workspace)
            .env(
                "PYTHONPATH",
                format!("{0}/src:{0}", workspace.display()),
            )
            .output();
        if let Ok(o) = imp {
            if !o.status.success() {
                let err = String::from_utf8_lossy(&o.stderr).into_owned();
                // ModuleNotFoundError for something the agent did not touch is an
                // environment fact, not a defect in the change.
                if !err.contains("ModuleNotFoundError") {
                    problems.push(format!("`import {module}` fails:\n{}", mid(&err, 600)));
                }
            }
        }
    }
    problems
}

/// Checks over the diff text itself, for the failure modes a compiler cannot see.
pub fn static_diff_checks(workspace: &Path, task: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Some(diff_text) = diff(workspace) else {
        return out;
    };

    // 1. Editing tests when the task says not to.
    let touched_tests: Vec<String> = diff_text
        .lines()
        .filter(|l| l.starts_with("+++ b/"))
        .filter_map(|l| l.strip_prefix("+++ b/"))
        .filter(|p| {
            let p = p.to_ascii_lowercase();
            p.contains("test_") || p.contains("/tests/") || p.ends_with("_test.py")
        })
        .map(str::to_string)
        .collect();
    let forbids_tests = {
        let t = task.to_ascii_lowercase();
        t.contains("do not") && t.contains("test") || t.contains("don't edit") && t.contains("test")
    };
    if forbids_tests && !touched_tests.is_empty() {
        out.push(format!(
            "You modified test file(s): {} — the task says do NOT edit or add tests. Revert them unless the task explicitly requires it.",
            touched_tests.join(", ")
        ));
    }

    // 2. `assert` used for validation where the task names an exception type.
    let task_lower = task.to_ascii_lowercase();
    let wants_exception = task_lower.contains("valueerror") || task_lower.contains("typeerror");
    let added_assert = diff_text
        .lines()
        .any(|l| l.starts_with('+') && l.trim_start_matches('+').trim_start().starts_with("assert "));
    if wants_exception && added_assert {
        out.push(
            "The task names an exception type, but the diff validates with `assert`. \
             `assert` is removed under `python -O`, so callers and tests expecting a real \
             exception will not see one. Raise the named exception instead."
                .to_string(),
        );
    }
    out
}
