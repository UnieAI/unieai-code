//! The `Stop` hook entry point: stdin in, one JSON object out.
//!
//! Dispatched from argv (see `codex-rs/arg0`), so the same binary that runs the
//! agent also runs its completion contract — no second runtime, no separate
//! package to keep in step with the release.

use crate::ContractState;
use crate::SkepticMode;
use crate::Turn;
use crate::Verdict;
use crate::state;
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

/// The argv flag that runs this binary as the completion-contract Stop hook.
///
/// Mirrors `apply_patch`'s `--codex-run-as-apply-patch`: a hidden entry point on
/// the main binary rather than a separate executable, so `command = "unieai
/// --run-as-completion-hook"` in a hooks config always matches the running agent.
pub const ARG1: &str = "--run-as-completion-hook";

/// `StopCommandInput` (codex-rs/hooks/src/schema.rs), read leniently: unknown
/// fields are ignored so a newer codex adding one cannot break the hook.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct StopInput {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    turn_id: String,
    #[serde(default)]
    transcript_path: Option<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    stop_hook_active: bool,
    #[serde(default)]
    last_assistant_message: Option<String>,
}

/// The user's actual request for this turn, recovered from the rollout.
///
/// The skeptic judges the diff against the task, so a wrong task here is worse
/// than none — it would review the work against something nobody asked for. Take
/// the LAST user message and skip the wrappers a harness injects, including our
/// own previous nudges.
fn task_from_transcript(path: &Path) -> String {
    const SYNTHETIC: [&str; 6] = [
        "[verification]",
        "[loop guardrail]",
        "<project_instructions>",
        "<context_update>",
        "<conversation_summary>",
        "No files in the workspace have been modified",
    ];
    let Ok(body) = std::fs::read_to_string(path) else {
        return String::new();
    };
    for line in body.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let item = value
            .get("payload")
            .or_else(|| value.get("item"))
            .unwrap_or(&value);
        if item.get("type").and_then(|t| t.as_str()) != Some("message")
            || item.get("role").and_then(|r| r.as_str()) != Some("user")
        {
            continue;
        }
        let text: String = item
            .get("content")
            .and_then(|c| c.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                    .collect::<String>()
            })
            .unwrap_or_default();
        let text = text.trim();
        if text.is_empty() || SYNTHETIC.iter().any(|s| text.starts_with(s)) {
            continue;
        }
        return text.to_string();
    }
    String::new()
}

/// Let the turn end. The only safe answer to anything unexpected.
fn allow() -> ! {
    println!("{{}}");
    std::process::exit(0);
}

fn codex_home() -> PathBuf {
    std::env::var_os("UNIEAI_HOME")
        .or_else(|| std::env::var_os("CODEX_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// Entry point. Never returns.
pub fn main() -> ! {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        allow();
    }
    let Ok(input) = serde_json::from_str::<StopInput>(&raw) else {
        allow();
    };
    if input.cwd.is_empty() {
        allow();
    }
    let workspace = PathBuf::from(&input.cwd);

    let max_nudges: u32 = std::env::var("UNIEAI_MAX_NUDGES")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(state::DEFAULT_MAX_NUDGES);
    let mode = SkepticMode::parse(
        &std::env::var("UNIEAI_SKEPTIC_MODE").unwrap_or_else(|_| "nudged".to_string()),
    );

    let path = state::state_path(&codex_home(), &input.session_id);
    let mut session = state::load(&path);
    session.enter_turn(&input.turn_id);
    if session.turn.nudges >= max_nudges {
        allow();
    }

    let task = input
        .transcript_path
        .as_deref()
        .map(Path::new)
        .filter(|p| p.exists())
        .map(task_from_transcript)
        .unwrap_or_default();

    // Did this turn have to be pushed to get here? codex's own re-entry flag
    // answers that without us tracking it — it is set precisely when a previous
    // block in THIS turn was accepted.
    let was_nudged = input.stop_hook_active || session.turn.nudges > 0;
    let model = input.model.clone().unwrap_or_default();

    let turn = Turn {
        workspace: &workspace,
        task: &task,
        answer_text: input.last_assistant_message.as_deref().unwrap_or(""),
        was_nudged,
    };
    let mut view: ContractState = session.view();
    let verdict = crate::evaluate(&turn, &mut view, mode, |system, user| {
        crate::review::call(&model, system, user)
    });
    session.absorb(view);

    match verdict {
        Verdict::Allow => {
            state::save(&path, &session);
            allow()
        }
        Verdict::Block(reason) => {
            session.turn.nudges += 1;
            state::save(&path, &session);
            let out = serde_json::json!({ "decision": "block", "reason": reason });
            println!("{out}");
            std::process::exit(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn rollout(lines: &[&str]) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().expect("tempfile");
        for l in lines {
            writeln!(f, "{l}").expect("write");
        }
        f
    }

    #[test]
    fn the_last_real_user_message_is_the_task() {
        let f = rollout(&[
            r#"{"type":"message","role":"user","content":[{"text":"fix the parser"}]}"#,
            r#"{"type":"message","role":"assistant","content":[{"text":"done"}]}"#,
        ]);
        assert_eq!(task_from_transcript(f.path()), "fix the parser");
    }

    #[test]
    fn injected_wrappers_are_not_the_task() {
        // Reviewing the diff against our own previous nudge would judge the work
        // against something the user never asked for.
        let f = rollout(&[
            r#"{"type":"message","role":"user","content":[{"text":"fix the parser"}]}"#,
            r#"{"type":"message","role":"user","content":[{"text":"[verification] A skeptical review found gaps:"}]}"#,
            r#"{"type":"message","role":"user","content":[{"text":"<context_update>date changed</context_update>"}]}"#,
        ]);
        assert_eq!(task_from_transcript(f.path()), "fix the parser");
    }

    #[test]
    fn a_wrapped_payload_is_unwrapped() {
        let f = rollout(&[
            r#"{"payload":{"type":"message","role":"user","content":[{"text":"wrapped task"}]}}"#,
        ]);
        assert_eq!(task_from_transcript(f.path()), "wrapped task");
    }

    #[test]
    fn a_torn_or_missing_transcript_yields_no_task() {
        // No task is recoverable, so the skeptic judges against an empty string
        // rather than against garbage. Better than inventing one.
        let f = rollout(&["not json", "", r#"{"type":"message","role":"assistant"}"#]);
        assert_eq!(task_from_transcript(f.path()), "");
        assert_eq!(task_from_transcript(Path::new("/nonexistent")), "");
    }
}
