//! Full-screen diff viewer: pure model behind the UI.
//!
//! Inspired by opencode's `feature-plugins/system/diff-viewer.tsx`. This is the
//! pure foundation: a small robust unified-diff parser, a unified/split view
//! toggle with split row pairing, a file list with per-file review state and
//! next-unreviewed navigation, and a comparison-source selector.
//!
//! What is DEFERRED (not here): the full-screen rendering, key handling, and the
//! git invocations that actually PRODUCE each diff (workspace / main branch /
//! previous turn). This model only parses a diff it is handed and tracks which
//! source is selected.
#![allow(dead_code)]

/// The classification of a single diff body line.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LineKind {
    /// Unchanged context line (present on both sides).
    Ctx,
    /// Added line (present only on the new side).
    Add,
    /// Deleted line (present only on the old side).
    Del,
}

/// One line inside a hunk.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DiffLine {
    pub(crate) kind: LineKind,
    pub(crate) text: String,
}

impl DiffLine {
    fn new(kind: LineKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
        }
    }
}

/// A `(start, count)` line range from a hunk header.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct Range {
    pub(crate) start: usize,
    pub(crate) count: usize,
}

/// A single `@@ ... @@` hunk.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Hunk {
    pub(crate) old_range: Range,
    pub(crate) new_range: Range,
    pub(crate) lines: Vec<DiffLine>,
}

/// All hunks for one file.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct FileDiff {
    pub(crate) path: String,
    pub(crate) hunks: Vec<Hunk>,
}

/// Parse a unified-diff string into per-file [`FileDiff`]s.
///
/// Handles multiple files (`diff --git` and/or `---`/`+++` headers),
/// `@@ -a,b +c,d @@` hunk headers (counts optional, defaulting to 1), and
/// `+` / `-` / ` ` body-line prefixes. Body lines are consumed by the hunk's
/// declared old/new line budget, so an added line that itself begins with `+`
/// (e.g. `+++x`) is not mistaken for a header.
pub(crate) fn parse_unified_diff(input: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut cur_file: Option<FileDiff> = None;
    // Remaining old/new lines the current hunk still expects.
    let mut old_left = 0usize;
    let mut new_left = 0usize;

    let flush_file = |files: &mut Vec<FileDiff>, f: &mut Option<FileDiff>| {
        if let Some(file) = f.take() {
            files.push(file);
        }
    };

    for raw in input.lines() {
        let in_hunk_body = old_left > 0 || new_left > 0;

        if in_hunk_body {
            // Classify strictly by first byte; the header check is skipped until
            // the hunk's line budget is exhausted.
            let (kind, text) = match raw.as_bytes().first() {
                Some(b'+') => (LineKind::Add, &raw[1..]),
                Some(b'-') => (LineKind::Del, &raw[1..]),
                Some(b' ') => (LineKind::Ctx, &raw[1..]),
                Some(b'\\') => continue, // "\ No newline at end of file"
                _ => (LineKind::Ctx, raw), // bare/empty context line
            };
            match kind {
                LineKind::Add => new_left = new_left.saturating_sub(1),
                LineKind::Del => old_left = old_left.saturating_sub(1),
                LineKind::Ctx => {
                    old_left = old_left.saturating_sub(1);
                    new_left = new_left.saturating_sub(1);
                }
            }
            if let Some(file) = cur_file.as_mut() {
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine::new(kind, text));
                }
            }
            continue;
        }

        // Header context (not inside a hunk body).
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            flush_file(&mut files, &mut cur_file);
            cur_file = Some(FileDiff {
                path: path_from_git_header(rest),
                hunks: Vec::new(),
            });
        } else if let Some(rest) = raw.strip_prefix("+++ ") {
            // Prefer the new-side path; ignore for pure deletions (/dev/null).
            if let Some(path) = clean_path(rest) {
                let file = cur_file.get_or_insert_with(FileDiff::default);
                file.path = path;
            }
        } else if let Some(rest) = raw.strip_prefix("--- ") {
            // Only used as a fallback path when there is no usable +++ path.
            if cur_file.is_none() {
                cur_file = Some(FileDiff::default());
            }
            if let (Some(file), Some(path)) = (cur_file.as_mut(), clean_path(rest)) {
                if file.path.is_empty() {
                    file.path = path;
                }
            }
        } else if raw.starts_with("@@") {
            if let Some((old_range, new_range)) = parse_hunk_header(raw) {
                old_left = old_range.count;
                new_left = new_range.count;
                let file = cur_file.get_or_insert_with(FileDiff::default);
                file.hunks.push(Hunk {
                    old_range,
                    new_range,
                    lines: Vec::new(),
                });
            }
        }
        // Any other line outside a hunk (index, mode, etc.) is ignored.
    }

    flush_file(&mut files, &mut cur_file);
    files
}

/// Extract the file path from the remainder of a `diff --git ` line, preferring
/// the `b/` (new) path.
fn path_from_git_header(rest: &str) -> String {
    let parts: Vec<&str> = rest.split_whitespace().collect();
    if let Some(b) = parts.last() {
        if let Some(p) = clean_path(b) {
            return p;
        }
    }
    parts
        .first()
        .and_then(|a| clean_path(a))
        .unwrap_or_default()
}

/// Strip an `a/` or `b/` prefix and drop `/dev/null`; also drop any trailing
/// tab-delimited timestamp some diffs append.
fn clean_path(token: &str) -> Option<String> {
    let token = token.split('\t').next().unwrap_or(token).trim();
    if token.is_empty() || token == "/dev/null" {
        return None;
    }
    let stripped = token
        .strip_prefix("a/")
        .or_else(|| token.strip_prefix("b/"))
        .unwrap_or(token);
    Some(stripped.to_string())
}

/// Parse `@@ -a,b +c,d @@` (counts optional → default 1).
fn parse_hunk_header(line: &str) -> Option<(Range, Range)> {
    let inner = line.trim_start_matches('@').trim();
    // inner now looks like "-a,b +c,d @@ optional section heading"
    let mut old_range = None;
    let mut new_range = None;
    for tok in inner.split_whitespace() {
        if let Some(spec) = tok.strip_prefix('-') {
            old_range = parse_range(spec);
        } else if let Some(spec) = tok.strip_prefix('+') {
            new_range = parse_range(spec);
            break; // both ranges collected
        }
    }
    Some((old_range?, new_range?))
}

fn parse_range(spec: &str) -> Option<Range> {
    let mut it = spec.split(',');
    let start: usize = it.next()?.parse().ok()?;
    let count: usize = match it.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some(Range { start, count })
}

/// Unified vs split (side-by-side) rendering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ViewMode {
    Unified,
    Split,
}

impl ViewMode {
    pub(crate) fn toggle(self) -> Self {
        match self {
            ViewMode::Unified => ViewMode::Split,
            ViewMode::Split => ViewMode::Unified,
        }
    }
}

/// One row of the split (side-by-side) layout. `None` in a column means a blank
/// gutter (the other side has content this side does not).
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct SplitRow {
    pub(crate) left: Option<String>,
    pub(crate) right: Option<String>,
}

/// Pair a hunk's lines into left/right split rows: context lines appear on both
/// sides; a run of deletions is paired positionally with the following run of
/// additions (extra deletions become left-only rows, extra additions right-only).
pub(crate) fn split_rows(hunk: &Hunk) -> Vec<SplitRow> {
    let mut rows = Vec::new();
    let mut dels: Vec<&str> = Vec::new();
    let mut adds: Vec<&str> = Vec::new();

    let flush = |rows: &mut Vec<SplitRow>, dels: &mut Vec<&str>, adds: &mut Vec<&str>| {
        let n = dels.len().max(adds.len());
        for i in 0..n {
            rows.push(SplitRow {
                left: dels.get(i).map(|s| s.to_string()),
                right: adds.get(i).map(|s| s.to_string()),
            });
        }
        dels.clear();
        adds.clear();
    };

    for line in &hunk.lines {
        match line.kind {
            LineKind::Del => dels.push(&line.text),
            LineKind::Add => adds.push(&line.text),
            LineKind::Ctx => {
                flush(&mut rows, &mut dels, &mut adds);
                rows.push(SplitRow {
                    left: Some(line.text.clone()),
                    right: Some(line.text.clone()),
                });
            }
        }
    }
    flush(&mut rows, &mut dels, &mut adds);
    rows
}

/// Per-file review state in the file list.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReviewState {
    Reviewed,
    Unreviewed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) review: ReviewState,
}

/// The file list / tree model: an ordered list of files with a selection cursor
/// and per-file review state, plus next-unreviewed navigation.
#[derive(Clone, Debug, Default)]
pub(crate) struct FileList {
    entries: Vec<FileEntry>,
    selected: usize,
}

impl FileList {
    pub(crate) fn new(paths: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            entries: paths
                .into_iter()
                .map(|p| FileEntry {
                    path: p.into(),
                    review: ReviewState::Unreviewed,
                })
                .collect(),
            selected: 0,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn entries(&self) -> &[FileEntry] {
        &self.entries
    }

    pub(crate) fn selected_index(&self) -> usize {
        self.selected
    }

    pub(crate) fn selected(&self) -> Option<&FileEntry> {
        self.entries.get(self.selected)
    }

    pub(crate) fn select_prev(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub(crate) fn select_next(&mut self) {
        if !self.entries.is_empty() {
            self.selected = (self.selected + 1).min(self.entries.len() - 1);
        }
    }

    /// Toggle the review state of the selected file.
    pub(crate) fn toggle_reviewed(&mut self) {
        if let Some(entry) = self.entries.get_mut(self.selected) {
            entry.review = match entry.review {
                ReviewState::Reviewed => ReviewState::Unreviewed,
                ReviewState::Unreviewed => ReviewState::Reviewed,
            };
        }
    }

    /// Whether every file has been reviewed.
    pub(crate) fn all_reviewed(&self) -> bool {
        !self.entries.is_empty()
            && self
                .entries
                .iter()
                .all(|e| e.review == ReviewState::Reviewed)
    }

    /// Move the selection to the next unreviewed file after the current one,
    /// wrapping around. Returns the new index, or `None` if all are reviewed.
    pub(crate) fn next_unreviewed(&mut self) -> Option<usize> {
        let n = self.entries.len();
        if n == 0 {
            return None;
        }
        for step in 1..=n {
            let idx = (self.selected + step) % n;
            if self.entries[idx].review == ReviewState::Unreviewed {
                self.selected = idx;
                return Some(idx);
            }
        }
        None
    }
}

/// The comparison base a diff is computed against. Producing each diff (the git
/// invocation) is DEFERRED; this only tracks which source is selected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DiffSource {
    /// Uncommitted changes in the working tree.
    Workspace,
    /// Difference against the `main` branch.
    MainBranch,
    /// Difference against the previous turn's snapshot.
    PrevTurn,
}

impl DiffSource {
    /// Cycle: Workspace → MainBranch → PrevTurn → Workspace.
    pub(crate) fn cycle(self) -> Self {
        match self {
            DiffSource::Workspace => DiffSource::MainBranch,
            DiffSource::MainBranch => DiffSource::PrevTurn,
            DiffSource::PrevTurn => DiffSource::Workspace,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            DiffSource::Workspace => "Workspace",
            DiffSource::MainBranch => "main branch",
            DiffSource::PrevTurn => "Previous turn",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_FILE_DIFF: &str = "\
diff --git a/src/foo.rs b/src/foo.rs
index 111..222 100644
--- a/src/foo.rs
+++ b/src/foo.rs
@@ -1,4 +1,4 @@
 fn foo() {
-    let x = 1;
+    let x = 2;
     println!(\"{x}\");
 }
@@ -10,2 +10,3 @@ fn bar() {
 // tail
+    let y = 3;
 // end
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
-old title
+new title
+subtitle
";

    #[test]
    fn parses_multiple_files_and_hunks() {
        let files = parse_unified_diff(TWO_FILE_DIFF);
        assert_eq!(files.len(), 2);

        let foo = &files[0];
        assert_eq!(foo.path, "src/foo.rs");
        assert_eq!(foo.hunks.len(), 2);

        let h0 = &foo.hunks[0];
        assert_eq!(h0.old_range, Range { start: 1, count: 4 });
        assert_eq!(h0.new_range, Range { start: 1, count: 4 });
        // context, del, add, context, context
        assert_eq!(h0.lines.len(), 5);
        assert_eq!(h0.lines[0].kind, LineKind::Ctx);
        assert_eq!(h0.lines[1].kind, LineKind::Del);
        assert_eq!(h0.lines[1].text, "    let x = 1;");
        assert_eq!(h0.lines[2].kind, LineKind::Add);
        assert_eq!(h0.lines[2].text, "    let x = 2;");

        let readme = &files[1];
        assert_eq!(readme.path, "README.md");
        assert_eq!(readme.hunks.len(), 1);
        // count omitted on the old side → defaults to 1.
        assert_eq!(readme.hunks[0].old_range, Range { start: 1, count: 1 });
        assert_eq!(readme.hunks[0].new_range, Range { start: 1, count: 2 });
    }

    #[test]
    fn added_line_beginning_with_plus_is_not_a_header() {
        // The added line's payload is literally "++nested" — the budget-based
        // parser must treat it as an Add, not a "+++" header.
        let diff = "\
--- a/x
+++ b/x
@@ -1,1 +1,2 @@
 keep
+++nested
";
        let files = parse_unified_diff(diff);
        assert_eq!(files.len(), 1);
        let lines = &files[0].hunks[0].lines;
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].kind, LineKind::Add);
        // Only the single `+` prefix is stripped; the literal payload remains.
        assert_eq!(lines[1].text, "++nested");
    }

    #[test]
    fn handles_new_file_against_dev_null() {
        let diff = "\
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
";
        let files = parse_unified_diff(diff);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].hunks[0].lines.len(), 2);
        assert!(files[0].hunks[0].lines.iter().all(|l| l.kind == LineKind::Add));
    }

    #[test]
    fn view_mode_toggles() {
        assert_eq!(ViewMode::Unified.toggle(), ViewMode::Split);
        assert_eq!(ViewMode::Split.toggle(), ViewMode::Unified);
    }

    #[test]
    fn split_rows_pair_add_del_and_context() {
        let hunk = Hunk {
            old_range: Range { start: 1, count: 3 },
            new_range: Range { start: 1, count: 3 },
            lines: vec![
                DiffLine::new(LineKind::Ctx, "ctx"),
                DiffLine::new(LineKind::Del, "old1"),
                DiffLine::new(LineKind::Del, "old2"),
                DiffLine::new(LineKind::Add, "new1"),
                DiffLine::new(LineKind::Ctx, "tail"),
            ],
        };
        let rows = split_rows(&hunk);
        // ctx row, then two del/add-paired rows, then ctx row.
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0], SplitRow { left: Some("ctx".into()), right: Some("ctx".into()) });
        // First del pairs with the single add.
        assert_eq!(rows[1], SplitRow { left: Some("old1".into()), right: Some("new1".into()) });
        // Second del has no add → left only.
        assert_eq!(rows[2], SplitRow { left: Some("old2".into()), right: None });
        assert_eq!(rows[3], SplitRow { left: Some("tail".into()), right: Some("tail".into()) });
    }

    #[test]
    fn split_rows_pure_addition_is_right_only() {
        let hunk = Hunk {
            old_range: Range { start: 0, count: 0 },
            new_range: Range { start: 1, count: 2 },
            lines: vec![
                DiffLine::new(LineKind::Add, "a"),
                DiffLine::new(LineKind::Add, "b"),
            ],
        };
        let rows = split_rows(&hunk);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.left.is_none() && r.right.is_some()));
    }

    #[test]
    fn file_list_toggle_and_all_reviewed() {
        let mut list = FileList::new(["a.rs", "b.rs"]);
        assert_eq!(list.len(), 2);
        assert!(!list.all_reviewed());
        assert_eq!(list.selected().unwrap().review, ReviewState::Unreviewed);

        list.toggle_reviewed();
        assert_eq!(list.selected().unwrap().review, ReviewState::Reviewed);
        assert!(!list.all_reviewed());

        list.select_next();
        list.toggle_reviewed();
        assert!(list.all_reviewed());

        // Toggling back off flips all_reviewed.
        list.toggle_reviewed();
        assert!(!list.all_reviewed());
    }

    #[test]
    fn file_list_selection_clamps() {
        let mut list = FileList::new(["a", "b"]);
        list.select_prev();
        assert_eq!(list.selected_index(), 0);
        list.select_next();
        list.select_next();
        assert_eq!(list.selected_index(), 1);
    }

    #[test]
    fn next_unreviewed_wraps_and_skips_reviewed() {
        let mut list = FileList::new(["a", "b", "c"]);
        // Mark "b" (index 1) reviewed; from index 0 the next unreviewed is "c".
        list.select_next();
        list.toggle_reviewed();
        list.select_prev();
        assert_eq!(list.selected_index(), 0);

        let next = list.next_unreviewed();
        assert_eq!(next, Some(2));
        assert_eq!(list.selected_index(), 2);

        // From "c", wrapping past the reviewed "b" lands back on "a".
        let next = list.next_unreviewed();
        assert_eq!(next, Some(0));

        // Once all are reviewed, there is no next.
        list.toggle_reviewed(); // a
        list.select_next();
        list.select_next(); // c
        list.toggle_reviewed(); // c
        assert!(list.all_reviewed());
        assert_eq!(list.next_unreviewed(), None);
    }

    #[test]
    fn empty_file_list_has_no_next_unreviewed() {
        let mut list = FileList::new(Vec::<String>::new());
        assert!(list.is_empty());
        assert!(!list.all_reviewed());
        assert_eq!(list.next_unreviewed(), None);
    }

    #[test]
    fn diff_source_cycles() {
        let s = DiffSource::Workspace;
        let s = s.cycle();
        assert_eq!(s, DiffSource::MainBranch);
        let s = s.cycle();
        assert_eq!(s, DiffSource::PrevTurn);
        let s = s.cycle();
        assert_eq!(s, DiffSource::Workspace);
    }
}
