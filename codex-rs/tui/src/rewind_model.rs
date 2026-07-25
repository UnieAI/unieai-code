//! Esc-Esc rewind picker: pure data model and preview logic.
//!
//! Inspired by grok-build's `views/rewind.rs` (`RewindMode`, `RewindPointInfo`,
//! conflict reporting), this is the **pure foundation** behind the rewind
//! picker: the three-axis mode, the ordered list of rewind points, a clamped
//! selection cursor, and — crucially — the *apply preview* (`RewindPreview`)
//! that the UI would show **before** applying anything.
//!
//! This module deliberately performs **no** revert: it does not touch the
//! filesystem, the conversation, or any agent-core revert API. It only assembles
//! the DATA the confirmation UI needs. The live Esc-Esc key handling and the
//! actual call into the `session-checkpoint-revert` revert API are DEFERRED.
#![allow(dead_code)]

/// Maximum characters kept for a rewind point's prompt preview.
const PROMPT_PREVIEW_MAX: usize = 60;

/// The three rewind axes: what a rewind should restore.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RewindMode {
    /// Rewind the conversation only; leave files on disk untouched.
    ConversationOnly,
    /// Restore file snapshots only; leave the conversation intact.
    FilesOnly,
    /// Rewind both the conversation and the files.
    Both,
}

impl RewindMode {
    /// Cycle to the next mode: Conversation → Files → Both → Conversation.
    pub(crate) fn cycle(self) -> Self {
        match self {
            RewindMode::ConversationOnly => RewindMode::FilesOnly,
            RewindMode::FilesOnly => RewindMode::Both,
            RewindMode::Both => RewindMode::ConversationOnly,
        }
    }

    /// Whether this mode restores file snapshots.
    pub(crate) fn restores_files(self) -> bool {
        matches!(self, RewindMode::FilesOnly | RewindMode::Both)
    }

    /// Whether this mode rewinds the conversation.
    pub(crate) fn restores_conversation(self) -> bool {
        matches!(self, RewindMode::ConversationOnly | RewindMode::Both)
    }

    /// A short human label for the mode.
    pub(crate) fn label(self) -> &'static str {
        match self {
            RewindMode::ConversationOnly => "Conversation only",
            RewindMode::FilesOnly => "Files only",
            RewindMode::Both => "Conversation + files",
        }
    }
}

impl Default for RewindMode {
    fn default() -> Self {
        RewindMode::Both
    }
}

/// Why restoring a particular file would conflict with the current worktree.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConflictKind {
    /// The file has uncommitted local edits that the restore would overwrite.
    LocalEdit,
    /// The path is untracked / newly created and would be clobbered.
    Untracked,
}

/// A single file that cannot be cleanly restored at the chosen point.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Conflict {
    pub(crate) path: String,
    pub(crate) kind: ConflictKind,
}

/// A file captured in a rewind point's snapshot, with whether restoring it
/// would collide with the current worktree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileSnapshot {
    pub(crate) path: String,
    /// If set, restoring this file conflicts for the given reason.
    pub(crate) conflict: Option<ConflictKind>,
}

impl FileSnapshot {
    pub(crate) fn clean(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            conflict: None,
        }
    }

    pub(crate) fn conflicting(path: impl Into<String>, kind: ConflictKind) -> Self {
        Self {
            path: path.into(),
            conflict: Some(kind),
        }
    }
}

/// The raw description of one candidate rewind point, before it is condensed
/// into a display-friendly [`RewindPoint`]. This is what an ordered transcript
/// scan would hand the picker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RewindCandidate {
    /// The user prompt that opened this turn (used for the preview text).
    pub(crate) prompt: String,
    /// The file snapshots captured at this point.
    pub(crate) snapshots: Vec<FileSnapshot>,
}

impl RewindCandidate {
    pub(crate) fn new(prompt: impl Into<String>, snapshots: Vec<FileSnapshot>) -> Self {
        Self {
            prompt: prompt.into(),
            snapshots,
        }
    }
}

/// A display row in the rewind picker: prompt preview, snapshot count and a flag
/// for whether any file changed at this point.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RewindPoint {
    pub(crate) index: usize,
    pub(crate) prompt_preview: String,
    pub(crate) snapshot_count: usize,
    pub(crate) has_file_changes: bool,
}

impl RewindPoint {
    /// Build the ordered list of display points from an ordered candidate list.
    /// The index mirrors the candidate's position, so it can be used to look the
    /// candidate back up.
    pub(crate) fn from_candidates(candidates: &[RewindCandidate]) -> Vec<RewindPoint> {
        candidates
            .iter()
            .enumerate()
            .map(|(index, c)| RewindPoint {
                index,
                prompt_preview: preview_prompt(&c.prompt),
                snapshot_count: c.snapshots.len(),
                has_file_changes: !c.snapshots.is_empty(),
            })
            .collect()
    }
}

/// Condense a prompt into a single-line preview, truncated on a char boundary.
fn preview_prompt(prompt: &str) -> String {
    let flat: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PROMPT_PREVIEW_MAX {
        return flat;
    }
    let truncated: String = flat
        .chars()
        .take(PROMPT_PREVIEW_MAX.saturating_sub(1))
        .collect();
    format!("{truncated}…")
}

/// The pure apply-preview: what the confirmation UI shows before the user
/// commits to a rewind. Nothing here is applied.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RewindPreview {
    /// Whether the conversation would be rewound (mode-dependent).
    pub(crate) restores_conversation: bool,
    /// The files that would be restored (empty when the mode restores no files).
    pub(crate) files_to_restore: Vec<String>,
    /// Any files that would conflict with the current worktree.
    pub(crate) conflicts: Vec<Conflict>,
}

impl RewindPreview {
    /// Assemble the preview for a candidate at the given mode. Pure: reads the
    /// candidate's snapshots and reports what *would* happen, per the mode.
    ///
    /// - `ConversationOnly`: no files, no conflicts.
    /// - `FilesOnly` / `Both`: every snapshot path is restored, and conflicting
    ///   snapshots surface as [`Conflict`]s.
    pub(crate) fn assemble(candidate: &RewindCandidate, mode: RewindMode) -> Self {
        let restores_conversation = mode.restores_conversation();
        if !mode.restores_files() {
            return RewindPreview {
                restores_conversation,
                files_to_restore: Vec::new(),
                conflicts: Vec::new(),
            };
        }
        let files_to_restore = candidate.snapshots.iter().map(|s| s.path.clone()).collect();
        let conflicts = candidate
            .snapshots
            .iter()
            .filter_map(|s| {
                s.conflict.map(|kind| Conflict {
                    path: s.path.clone(),
                    kind,
                })
            })
            .collect();
        RewindPreview {
            restores_conversation,
            files_to_restore,
            conflicts,
        }
    }

    pub(crate) fn has_conflicts(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// The rewind picker model: owns the ordered candidates, derives the display
/// points, tracks a clamped selection cursor and the current mode, and produces
/// the apply-preview for the current selection. No rendering, no revert.
#[derive(Clone, Debug)]
pub(crate) struct RewindPicker {
    candidates: Vec<RewindCandidate>,
    points: Vec<RewindPoint>,
    selected: usize,
    mode: RewindMode,
}

impl RewindPicker {
    pub(crate) fn new(candidates: Vec<RewindCandidate>) -> Self {
        let points = RewindPoint::from_candidates(&candidates);
        Self {
            candidates,
            points,
            selected: 0,
            mode: RewindMode::default(),
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.points.is_empty()
    }

    pub(crate) fn points(&self) -> &[RewindPoint] {
        &self.points
    }

    pub(crate) fn mode(&self) -> RewindMode {
        self.mode
    }

    pub(crate) fn cycle_mode(&mut self) {
        self.mode = self.mode.cycle();
    }

    pub(crate) fn set_mode(&mut self, mode: RewindMode) {
        self.mode = mode;
    }

    pub(crate) fn selected_index(&self) -> usize {
        self.selected
    }

    /// Move the selection up (toward index 0), clamped at the top.
    pub(crate) fn move_up(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    /// Move the selection down (toward the last point), clamped at the bottom.
    pub(crate) fn move_down(&mut self) {
        if self.points.is_empty() {
            return;
        }
        let last = self.points.len() - 1;
        self.selected = (self.selected + 1).min(last);
    }

    pub(crate) fn selected_point(&self) -> Option<&RewindPoint> {
        self.points.get(self.selected)
    }

    /// The apply-preview for the current selection and mode.
    pub(crate) fn preview(&self) -> Option<RewindPreview> {
        self.candidates
            .get(self.selected)
            .map(|c| RewindPreview::assemble(c, self.mode))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_candidates() -> Vec<RewindCandidate> {
        vec![
            RewindCandidate::new(
                "  refactor   the parser  ",
                vec![
                    FileSnapshot::clean("src/parse.rs"),
                    FileSnapshot::conflicting("src/lib.rs", ConflictKind::LocalEdit),
                ],
            ),
            RewindCandidate::new("add tests", vec![FileSnapshot::clean("tests/t.rs")]),
            RewindCandidate::new("no file turn", vec![]),
        ]
    }

    #[test]
    fn mode_cycles_through_all_three() {
        let m = RewindMode::ConversationOnly;
        let m = m.cycle();
        assert_eq!(m, RewindMode::FilesOnly);
        let m = m.cycle();
        assert_eq!(m, RewindMode::Both);
        let m = m.cycle();
        assert_eq!(m, RewindMode::ConversationOnly);
    }

    #[test]
    fn mode_predicates() {
        assert!(RewindMode::ConversationOnly.restores_conversation());
        assert!(!RewindMode::ConversationOnly.restores_files());
        assert!(RewindMode::FilesOnly.restores_files());
        assert!(!RewindMode::FilesOnly.restores_conversation());
        assert!(RewindMode::Both.restores_files());
        assert!(RewindMode::Both.restores_conversation());
    }

    #[test]
    fn points_built_from_ordered_candidates() {
        let points = RewindPoint::from_candidates(&sample_candidates());
        assert_eq!(points.len(), 3);
        assert_eq!(points[0].index, 0);
        // Whitespace is flattened in the preview.
        assert_eq!(points[0].prompt_preview, "refactor the parser");
        assert_eq!(points[0].snapshot_count, 2);
        assert!(points[0].has_file_changes);
        // The third point captured no files.
        assert_eq!(points[2].snapshot_count, 0);
        assert!(!points[2].has_file_changes);
    }

    #[test]
    fn prompt_preview_truncates_on_char_boundary() {
        let long = "x".repeat(200);
        let p = preview_prompt(&long);
        assert_eq!(p.chars().count(), PROMPT_PREVIEW_MAX);
        assert!(p.ends_with('…'));

        // Multibyte content must not panic and must stay within the budget.
        let multibyte = "回捲".repeat(100);
        let pm = preview_prompt(&multibyte);
        assert!(pm.chars().count() <= PROMPT_PREVIEW_MAX);
    }

    #[test]
    fn selection_clamps_at_both_ends() {
        let mut picker = RewindPicker::new(sample_candidates());
        assert_eq!(picker.selected_index(), 0);
        // Up at the top is a no-op.
        picker.move_up();
        assert_eq!(picker.selected_index(), 0);

        picker.move_down();
        picker.move_down();
        assert_eq!(picker.selected_index(), 2);
        // Down at the bottom is a no-op.
        picker.move_down();
        assert_eq!(picker.selected_index(), 2);

        picker.move_up();
        assert_eq!(picker.selected_index(), 1);
    }

    #[test]
    fn empty_picker_is_inert() {
        let mut picker = RewindPicker::new(vec![]);
        assert!(picker.is_empty());
        picker.move_down();
        picker.move_up();
        assert_eq!(picker.selected_index(), 0);
        assert!(picker.selected_point().is_none());
        assert!(picker.preview().is_none());
    }

    #[test]
    fn preview_files_only_lists_files_and_conflicts() {
        let candidates = sample_candidates();
        let preview = RewindPreview::assemble(&candidates[0], RewindMode::FilesOnly);
        assert!(!preview.restores_conversation);
        assert_eq!(preview.files_to_restore, vec!["src/parse.rs", "src/lib.rs"]);
        assert!(preview.has_conflicts());
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(preview.conflicts[0].path, "src/lib.rs");
        assert_eq!(preview.conflicts[0].kind, ConflictKind::LocalEdit);
    }

    #[test]
    fn preview_conversation_only_reports_no_files() {
        let candidates = sample_candidates();
        let preview = RewindPreview::assemble(&candidates[0], RewindMode::ConversationOnly);
        assert!(preview.restores_conversation);
        assert!(preview.files_to_restore.is_empty());
        assert!(preview.conflicts.is_empty());
    }

    #[test]
    fn preview_both_reports_conversation_and_files() {
        let candidates = sample_candidates();
        let preview = RewindPreview::assemble(&candidates[0], RewindMode::Both);
        assert!(preview.restores_conversation);
        assert_eq!(preview.files_to_restore.len(), 2);
        assert_eq!(preview.conflicts.len(), 1);
    }

    #[test]
    fn picker_preview_tracks_selection_and_mode() {
        let mut picker = RewindPicker::new(sample_candidates());
        picker.set_mode(RewindMode::Both);
        // First point has two files.
        let p0 = picker.preview().unwrap();
        assert_eq!(p0.files_to_restore.len(), 2);

        picker.move_down();
        let p1 = picker.preview().unwrap();
        assert_eq!(p1.files_to_restore, vec!["tests/t.rs"]);
        assert!(!p1.has_conflicts());

        // Cycling to conversation-only drops the files from the preview.
        picker.set_mode(RewindMode::ConversationOnly);
        let p1_conv = picker.preview().unwrap();
        assert!(p1_conv.files_to_restore.is_empty());
    }
}
