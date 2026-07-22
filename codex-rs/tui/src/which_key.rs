//! which-key overlay data: the reachable key rows for the current mode-stack.
//!
//! Inspired by opencode's which-key, this derives — from a stack of contextual
//! [`Mode`]s — the list of `(KeyChord, label)` rows the overlay should display,
//! with **inner modes overriding outer ones** on a chord conflict. Pushing a
//! mode (e.g. entering a "git" or "search" sub-context) layers its bindings on
//! top of what's already reachable; popping restores the prior view.
//!
//! This is the **pure data model** only: mode-stack push/pop, row derivation
//! (dedup + override + deterministic order), and paging. No rendering — a later
//! overlay widget consumes [`rows`](ModeStack::rows) / [`pages`](ModeStack::pages).
//!
//! [`rows`]: ModeStack::rows
//! [`pages`]: ModeStack::pages
#![allow(dead_code)]

use crate::action_registry::KeyChord;

/// One reachable binding row in the overlay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WhichKeyRow {
    pub(crate) chord: KeyChord,
    pub(crate) label: String,
}

impl WhichKeyRow {
    pub(crate) fn new(chord: KeyChord, label: impl Into<String>) -> Self {
        Self {
            chord,
            label: label.into(),
        }
    }
}

/// A contextual binding layer: a named set of `(chord, label)` bindings that
/// become reachable while this mode is on the stack.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Mode {
    pub(crate) name: String,
    bindings: Vec<(KeyChord, String)>,
}

impl Mode {
    /// A named, empty mode.
    pub(crate) fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            bindings: Vec::new(),
        }
    }

    /// Builder: add a binding to this mode.
    pub(crate) fn bind(mut self, chord: KeyChord, label: impl Into<String>) -> Self {
        self.bindings.push((chord, label.into()));
        self
    }
}

/// A stack of contextual modes. The bottom is the base context; each push layers
/// a sub-context whose bindings shadow those below on chord conflicts.
#[derive(Clone, Debug, Default)]
pub(crate) struct ModeStack {
    stack: Vec<Mode>,
}

impl ModeStack {
    /// An empty stack (no reachable bindings).
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// A stack seeded with a base mode.
    pub(crate) fn with_base(base: Mode) -> Self {
        Self { stack: vec![base] }
    }

    /// Push a contextual mode on top.
    pub(crate) fn push(&mut self, mode: Mode) {
        self.stack.push(mode);
    }

    /// Pop the top mode, returning it (if any).
    pub(crate) fn pop(&mut self) -> Option<Mode> {
        self.stack.pop()
    }

    /// The current (top) mode, if any.
    pub(crate) fn current(&self) -> Option<&Mode> {
        self.stack.last()
    }

    /// Stack depth.
    pub(crate) fn depth(&self) -> usize {
        self.stack.len()
    }

    /// The reachable overlay rows for the current stack.
    ///
    /// Bindings resolve bottom-up so that a chord bound by an inner (higher)
    /// mode overrides the same chord from an outer mode. Rows are returned in a
    /// deterministic order: by chord label, then binding label.
    pub(crate) fn rows(&self) -> Vec<WhichKeyRow> {
        // Walk bottom -> top so later (inner) modes overwrite earlier entries
        // for the same chord. A Vec keyed by chord keeps this dependency-light
        // (KeyChord is Hash, but avoiding a map keeps ordering explicit).
        let mut resolved: Vec<(KeyChord, String)> = Vec::new();
        for mode in &self.stack {
            for (chord, label) in &mode.bindings {
                if let Some(slot) = resolved.iter_mut().find(|(c, _)| c == chord) {
                    slot.1 = label.clone();
                } else {
                    resolved.push((*chord, label.clone()));
                }
            }
        }
        let mut rows: Vec<WhichKeyRow> = resolved
            .into_iter()
            .map(|(chord, label)| WhichKeyRow::new(chord, label))
            .collect();
        rows.sort_by(|a, b| {
            a.chord
                .to_string()
                .cmp(&b.chord.to_string())
                .then_with(|| a.label.cmp(&b.label))
        });
        rows
    }

    /// The reachable rows grouped into pages of at most `per_page` rows.
    ///
    /// Returns an empty `Vec` when there are no rows; `per_page` of 0 is treated
    /// as 1 to avoid an empty-chunk loop.
    pub(crate) fn pages(&self, per_page: usize) -> Vec<Vec<WhichKeyRow>> {
        let rows = self.rows();
        if rows.is_empty() {
            return Vec::new();
        }
        let per_page = per_page.max(1);
        rows.chunks(per_page).map(|c| c.to_vec()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyCode;

    fn base_mode() -> Mode {
        Mode::new("base")
            .bind(KeyChord::ctrl('p'), "Command Palette")
            .bind(KeyChord::plain(KeyCode::Tab), "Accept ghost")
    }

    #[test]
    fn push_pop_changes_current() {
        let mut stack = ModeStack::with_base(base_mode());
        assert_eq!(stack.current().unwrap().name, "base");
        assert_eq!(stack.depth(), 1);

        stack.push(Mode::new("git").bind(KeyChord::ctrl('g'), "Git status"));
        assert_eq!(stack.current().unwrap().name, "git");
        assert_eq!(stack.depth(), 2);

        let popped = stack.pop().unwrap();
        assert_eq!(popped.name, "git");
        assert_eq!(stack.current().unwrap().name, "base");
    }

    #[test]
    fn rows_union_bindings_across_the_stack() {
        let mut stack = ModeStack::with_base(base_mode());
        stack.push(Mode::new("git").bind(KeyChord::ctrl('g'), "Git status"));
        let labels: Vec<_> = stack.rows().into_iter().map(|r| r.label).collect();
        assert!(labels.contains(&"Command Palette".to_string()));
        assert!(labels.contains(&"Accept ghost".to_string()));
        assert!(labels.contains(&"Git status".to_string()));
        assert_eq!(labels.len(), 3);
    }

    #[test]
    fn inner_mode_overrides_outer_binding() {
        let mut stack = ModeStack::with_base(base_mode());
        // Rebind Ctrl+P in the inner mode.
        stack.push(Mode::new("search").bind(KeyChord::ctrl('p'), "Previous match"));
        let ctrl_p_label = stack
            .rows()
            .into_iter()
            .find(|r| r.chord == KeyChord::ctrl('p'))
            .map(|r| r.label);
        assert_eq!(ctrl_p_label.as_deref(), Some("Previous match"));
        // Popping restores the base binding.
        stack.pop();
        let ctrl_p_label = stack
            .rows()
            .into_iter()
            .find(|r| r.chord == KeyChord::ctrl('p'))
            .map(|r| r.label);
        assert_eq!(ctrl_p_label.as_deref(), Some("Command Palette"));
    }

    #[test]
    fn empty_stack_has_no_rows_or_pages() {
        let stack = ModeStack::new();
        assert!(stack.rows().is_empty());
        assert!(stack.pages(4).is_empty());
        assert!(stack.current().is_none());
    }

    #[test]
    fn rows_are_deterministically_ordered() {
        // Order of insertion should not affect the derived row order.
        let a = ModeStack::with_base(
            Mode::new("m")
                .bind(KeyChord::ctrl('z'), "Zed")
                .bind(KeyChord::ctrl('a'), "Ay"),
        )
        .rows();
        let b = ModeStack::with_base(
            Mode::new("m")
                .bind(KeyChord::ctrl('a'), "Ay")
                .bind(KeyChord::ctrl('z'), "Zed"),
        )
        .rows();
        assert_eq!(a, b);
        // "Ctrl+A" sorts before "Ctrl+Z".
        assert_eq!(a[0].label, "Ay");
        assert_eq!(a[1].label, "Zed");
    }

    #[test]
    fn pages_split_rows_by_size() {
        let stack = ModeStack::with_base(
            Mode::new("m")
                .bind(KeyChord::ctrl('a'), "A")
                .bind(KeyChord::ctrl('b'), "B")
                .bind(KeyChord::ctrl('c'), "C")
                .bind(KeyChord::ctrl('d'), "D")
                .bind(KeyChord::ctrl('e'), "E"),
        );
        let pages = stack.pages(2);
        assert_eq!(pages.len(), 3); // 2 + 2 + 1
        assert_eq!(pages[0].len(), 2);
        assert_eq!(pages[2].len(), 1);

        // per_page 0 is treated as 1 (one row per page).
        assert_eq!(stack.pages(0).len(), 5);
    }
}
