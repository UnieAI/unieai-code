//! State the contract carries, and where it lives between hook invocations.
//!
//! Two scopes, and mixing them up breaks the mechanism in opposite directions:
//!
//! · per TURN — `gates_ran`, `skeptic_ran`, `nudges`. Reset when the turn id
//!   changes. If these leaked across turns, each gate would fire once per
//!   session instead of once per turn and the contract would go quiet.
//!
//! · per SESSION — `consecutive_not_achieved`, `last_gap_fingerprint`. These are
//!   what notice a task failing review turn after turn; resetting them per turn
//!   would disable the escalation ladder and the stall exit entirely.
//!
//! The hook is a fresh process per invocation, so this is persisted to a file
//! keyed by session id. Losing it costs escalation, not correctness — every read
//! and write is best-effort.

use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;

/// How many times one turn may be sent back.
///
/// Matches the in-process implementation the SWE-bench numbers were measured
/// with. Note this budget is OURS: codex does not cap repeated blocks, and
/// `stop_hook_active` is informational — reading it as a budget silently limits
/// the contract to a single nudge per turn, which on the first smoke instance
/// was the difference between "I need to apply the fix" and the fix.
pub const DEFAULT_MAX_NUDGES: u32 = 5;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnState {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub nudges: u32,
    #[serde(default)]
    pub gates_ran: bool,
    #[serde(default)]
    pub gates_flagged: bool,
    #[serde(default)]
    pub skeptic_ran: bool,
    #[serde(default)]
    pub skeptic_skipped: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default)]
    pub turn: TurnState,
    #[serde(default)]
    pub consecutive_not_achieved: u32,
    #[serde(default)]
    pub last_gap_fingerprint: Option<String>,
}

/// The flattened view one evaluation reads and writes.
#[derive(Debug, Clone, Default)]
pub struct ContractState {
    pub gates_ran: bool,
    pub gates_flagged: bool,
    pub skeptic_ran: bool,
    pub skeptic_skipped: bool,
    pub consecutive_not_achieved: u32,
    pub last_gap_fingerprint: Option<String>,
}

impl SessionState {
    /// Start a fresh turn when the id changes, keeping the session-scoped half.
    pub fn enter_turn(&mut self, turn_id: &str) {
        if self.turn.id != turn_id {
            self.turn = TurnState {
                id: turn_id.to_string(),
                ..Default::default()
            };
        }
    }

    pub fn view(&self) -> ContractState {
        ContractState {
            gates_ran: self.turn.gates_ran,
            gates_flagged: self.turn.gates_flagged,
            skeptic_ran: self.turn.skeptic_ran,
            skeptic_skipped: self.turn.skeptic_skipped,
            consecutive_not_achieved: self.consecutive_not_achieved,
            last_gap_fingerprint: self.last_gap_fingerprint.clone(),
        }
    }

    pub fn absorb(&mut self, view: ContractState) {
        self.turn.gates_ran = view.gates_ran;
        self.turn.gates_flagged = view.gates_flagged;
        self.turn.skeptic_ran = view.skeptic_ran;
        self.turn.skeptic_skipped = view.skeptic_skipped;
        self.consecutive_not_achieved = view.consecutive_not_achieved;
        self.last_gap_fingerprint = view.last_gap_fingerprint;
    }
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn state_path(codex_home: &Path, session_id: &str) -> PathBuf {
    codex_home
        .join("completion-contract")
        .join(format!("{}.json", safe_id(session_id)))
}

pub fn load(path: &Path) -> SessionState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, state: &SessionState) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if let Ok(body) = serde_json::to_string(state) {
        let _ = std::fs::write(path, body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_turn_resets_only_the_turn_half() {
        let mut s = SessionState {
            turn: TurnState { id: "t1".into(), nudges: 3, gates_ran: true, ..Default::default() },
            consecutive_not_achieved: 2,
            last_gap_fingerprint: Some("gap".into()),
        };
        s.enter_turn("t2");
        assert_eq!(s.turn.nudges, 0, "the per-turn budget must restart");
        assert!(!s.turn.gates_ran);
        // The ladder is what notices a task failing turn after turn; resetting
        // it here would make escalation unreachable.
        assert_eq!(s.consecutive_not_achieved, 2);
        assert_eq!(s.last_gap_fingerprint.as_deref(), Some("gap"));
    }

    #[test]
    fn re_entering_the_same_turn_keeps_its_state() {
        let mut s = SessionState {
            turn: TurnState { id: "t1".into(), nudges: 2, skeptic_ran: true, ..Default::default() },
            ..Default::default()
        };
        s.enter_turn("t1");
        assert_eq!(s.turn.nudges, 2);
        assert!(s.turn.skeptic_ran, "the once-per-turn skeptic would run twice");
    }

    #[test]
    fn a_session_id_cannot_escape_its_directory() {
        // The separators are what make a traversal; `safe_id` replaces them, so
        // the whole id collapses into ONE filename. Dots surviving inside that
        // filename are harmless — the property to assert is that the path stays
        // in the directory and has exactly one component below it.
        let dir = Path::new("/home/u/.codex").join("completion-contract");
        for id in ["../../etc/passwd", "a/b/c", "..", "/absolute"] {
            let p = state_path(Path::new("/home/u/.codex"), id);
            assert!(p.starts_with(&dir), "{id} escaped to {p:?}");
            assert_eq!(
                p.strip_prefix(&dir).unwrap().components().count(),
                1,
                "{id} produced more than one path component"
            );
        }
    }

    #[test]
    fn a_missing_or_corrupt_state_file_is_not_an_error() {
        assert_eq!(load(Path::new("/nonexistent/nope.json")).consecutive_not_achieved, 0);
    }
}
