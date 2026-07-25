//! The single-source action registry behind the Ctrl+P command palette.
//!
//! The `tui-composer` spec wants one [`Registry`] that feeds the shortcut bar,
//! key dispatch, and the fuzzy palette. This module is the **pure data core** of
//! that idea: an [`Action`] describes a command (stable id, display title, search
//! keywords, an optional key [`KeyChord`], and whether selecting it needs an
//! argument), and [`Registry`] supports:
//!
//! * [`filter`](Registry::filter) — fuzzy (subsequence) ranking for the palette,
//! * [`lookup_binding`](Registry::lookup_binding) — resolve a key chord to its
//!   action for dispatch,
//! * [`by_id`](Registry::by_id) — direct lookup.
//!
//! It deliberately does **not** consolidate the codex TUI's existing actions —
//! that live-path refactor is the deferred, higher-risk half of the change. Only
//! the type + ranking live here, unit-tested in isolation. The one external type
//! it borrows is crossterm's key model, already a `codex-tui` dependency, so a
//! later wiring layer can build chords straight from real key events.
//!
//! Live wiring so far: the Ctrl+P palette
//! (`bottom_pane::command_palette_view`) builds a [`Registry`] from the slash
//! commands and uses [`Registry::filter`] for ranking. The chord/binding and
//! arg-picker halves are still awaiting their own wiring and keep targeted
//! `#[allow(dead_code)]` markers.

use std::fmt;

use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;

/// A single key combination bound to an [`Action`].
///
/// Wraps crossterm's [`KeyCode`] + [`KeyModifiers`] so a later wiring layer can
/// construct chords directly from real key events, and renders a human label
/// (`Ctrl+P`, `Alt+Enter`, `Tab`) for the palette / which-key overlays.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) struct KeyChord {
    pub(crate) code: KeyCode,
    pub(crate) mods: KeyModifiers,
}

impl KeyChord {
    /// A chord with explicit modifiers.
    #[allow(dead_code)] // deferred: key-dispatch wiring
    pub(crate) fn new(code: KeyCode, mods: KeyModifiers) -> Self {
        Self { code, mods }
    }

    /// A bare key with no modifiers (e.g. `Tab`, `Enter`).
    #[allow(dead_code)] // deferred: key-dispatch wiring
    pub(crate) fn plain(code: KeyCode) -> Self {
        Self {
            code,
            mods: KeyModifiers::NONE,
        }
    }

    /// A `Ctrl`+letter chord — the common palette / dispatch case.
    #[allow(dead_code)] // deferred: key-dispatch wiring
    pub(crate) fn ctrl(c: char) -> Self {
        Self {
            code: KeyCode::Char(c.to_ascii_lowercase()),
            mods: KeyModifiers::CONTROL,
        }
    }
}

impl fmt::Display for KeyChord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.mods.contains(KeyModifiers::CONTROL) {
            f.write_str("Ctrl+")?;
        }
        if self.mods.contains(KeyModifiers::ALT) {
            f.write_str("Alt+")?;
        }
        if self.mods.contains(KeyModifiers::SHIFT) {
            f.write_str("Shift+")?;
        }
        match self.code {
            KeyCode::Char(c) => write!(f, "{}", c.to_ascii_uppercase()),
            KeyCode::Enter => f.write_str("Enter"),
            KeyCode::Tab => f.write_str("Tab"),
            KeyCode::BackTab => f.write_str("BackTab"),
            KeyCode::Esc => f.write_str("Esc"),
            KeyCode::Backspace => f.write_str("Backspace"),
            KeyCode::Delete => f.write_str("Del"),
            KeyCode::Left => f.write_str("Left"),
            KeyCode::Right => f.write_str("Right"),
            KeyCode::Up => f.write_str("Up"),
            KeyCode::Down => f.write_str("Down"),
            KeyCode::Home => f.write_str("Home"),
            KeyCode::End => f.write_str("End"),
            KeyCode::PageUp => f.write_str("PgUp"),
            KeyCode::PageDown => f.write_str("PgDn"),
            KeyCode::F(n) => write!(f, "F{n}"),
            other => write!(f, "{other:?}"),
        }
    }
}

/// One command in the palette / dispatch registry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Action {
    /// Stable identifier, used for dispatch and direct lookup.
    pub(crate) id: String,
    /// Human-facing title shown in the palette and shortcut bar.
    pub(crate) title: String,
    /// Extra fuzzy-search terms beyond the title (synonyms, abbreviations).
    pub(crate) keywords: Vec<String>,
    /// Optional key binding for direct dispatch, if any.
    pub(crate) binding: Option<KeyChord>,
    /// Whether selecting this action needs a follow-up argument (arg-picker).
    pub(crate) needs_arg: bool,
}

impl Action {
    /// A minimal action: id + title, no keywords / binding / argument.
    pub(crate) fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            keywords: Vec::new(),
            binding: None,
            needs_arg: false,
        }
    }

    /// Builder: attach fuzzy-search keywords.
    #[allow(dead_code)] // deferred: synonym keywords for palette entries
    pub(crate) fn with_keywords<I, S>(mut self, keywords: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.keywords = keywords.into_iter().map(Into::into).collect();
        self
    }

    /// Builder: attach a key binding.
    #[allow(dead_code)] // deferred: shortcut hints / which-key wiring
    pub(crate) fn with_binding(mut self, chord: KeyChord) -> Self {
        self.binding = Some(chord);
        self
    }

    /// Builder: mark this action as needing an argument (arg-picker chain).
    ///
    /// The live palette decides arg handling from
    /// `SlashCommand::supports_inline_args` at the dispatch site instead; this
    /// flag remains for the deferred registry-consolidation step.
    #[allow(dead_code)]
    pub(crate) fn needs_arg(mut self) -> Self {
        self.needs_arg = true;
        self
    }

    /// Best fuzzy score for `query` across the title, id, and keywords, or
    /// `None` if the query is not a subsequence of any of them.
    fn score(&self, query: &str) -> Option<i32> {
        let mut best: Option<i32> = None;
        let mut consider = |hay: &str| {
            if let Some(s) = fuzzy_score(hay, query) {
                best = Some(best.map_or(s, |b| b.max(s)));
            }
        };
        consider(&self.title);
        consider(&self.id);
        for kw in &self.keywords {
            consider(kw);
        }
        best
    }
}

/// A subsequence fuzzy score for `needle` within `haystack`, case-insensitive.
///
/// Returns `None` unless every char of `needle` appears in `haystack` in order.
/// The score rewards matches that are contiguous and that start a word (index 0
/// or just after a separator), so `"of"` ranks `"Open File"` above an incidental
/// scatter, and an exact leading match outranks a mid-word one.
pub(crate) fn fuzzy_score(haystack: &str, needle: &str) -> Option<i32> {
    if needle.is_empty() {
        return Some(0);
    }
    let hay: Vec<char> = haystack.to_ascii_lowercase().chars().collect();
    let needle: Vec<char> = needle.to_ascii_lowercase().chars().collect();

    let mut score = 0i32;
    let mut n = 0usize; // index into needle
    let mut prev_matched = false;
    for (i, &hc) in hay.iter().enumerate() {
        if n >= needle.len() {
            break;
        }
        if hc == needle[n] {
            score += 1;
            let at_word_start = i == 0 || matches!(hay[i - 1], ' ' | '_' | '-' | '/' | '.' | ':');
            if at_word_start {
                score += 10;
            }
            if prev_matched {
                score += 5;
            }
            if i == 0 {
                score += 5;
            }
            prev_matched = true;
            n += 1;
        } else {
            prev_matched = false;
        }
    }
    if n == needle.len() { Some(score) } else { None }
}

/// The single source of truth for palette actions.
#[derive(Clone, Debug, Default)]
pub(crate) struct Registry {
    actions: Vec<Action>,
}

impl Registry {
    /// An empty registry.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Append an action, preserving insertion order (the palette's default
    /// ordering when there is no query).
    pub(crate) fn push(&mut self, action: Action) {
        self.actions.push(action);
    }

    /// All actions in insertion order.
    #[allow(dead_code)] // deferred: shortcut-bar rendering
    pub(crate) fn actions(&self) -> &[Action] {
        &self.actions
    }

    /// Fuzzy-rank the actions against `query`.
    ///
    /// An empty (or whitespace-only) query returns every action in insertion
    /// order. Otherwise only actions whose title / id / a keyword is a
    /// subsequence of the query survive, sorted by descending score; ties keep
    /// insertion order (the sort is stable).
    pub(crate) fn filter(&self, query: &str) -> Vec<&Action> {
        let query = query.trim();
        if query.is_empty() {
            return self.actions.iter().collect();
        }
        let mut scored: Vec<(i32, usize, &Action)> = self
            .actions
            .iter()
            .enumerate()
            .filter_map(|(i, a)| a.score(query).map(|s| (s, i, a)))
            .collect();
        // Higher score first; original index breaks ties for stability.
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        scored.into_iter().map(|(_, _, a)| a).collect()
    }

    /// Resolve a key chord to the action bound to it, if any. First match in
    /// insertion order wins.
    #[allow(dead_code)] // deferred: key-dispatch wiring
    pub(crate) fn lookup_binding(&self, chord: &KeyChord) -> Option<&Action> {
        self.actions
            .iter()
            .find(|a| a.binding.as_ref() == Some(chord))
    }

    /// Direct lookup by stable id.
    #[allow(dead_code)] // deferred: registry-consolidation wiring
    pub(crate) fn by_id(&self, id: &str) -> Option<&Action> {
        self.actions.iter().find(|a| a.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Registry {
        let mut r = Registry::new();
        r.push(
            Action::new("open_file", "Open File")
                .with_keywords(["load", "edit"])
                .with_binding(KeyChord::ctrl('o'))
                .needs_arg(),
        );
        r.push(Action::new("new_session", "New Session").with_keywords(["reset", "clear"]));
        r.push(Action::new("palette", "Command Palette").with_binding(KeyChord::ctrl('p')));
        r.push(Action::new("open_folder", "Open Folder").needs_arg());
        r
    }

    #[test]
    fn empty_query_returns_all_in_order() {
        let r = sample();
        let ids: Vec<_> = r.filter("").iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["open_file", "new_session", "palette", "open_folder"]);
        // Whitespace-only is treated as empty.
        assert_eq!(r.filter("   ").len(), 4);
    }

    #[test]
    fn subsequence_match_filters_out_non_matches() {
        let r = sample();
        // "of" is a subsequence of "Open File" and "Open Folder" but not others.
        let ids: Vec<_> = r.filter("of").iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"open_file"));
        assert!(ids.contains(&"open_folder"));
        assert!(!ids.contains(&"new_session"));
        assert!(!ids.contains(&"palette"));
    }

    #[test]
    fn keyword_match_surfaces_action() {
        let r = sample();
        // "reset" only appears as a keyword of New Session.
        let ids: Vec<_> = r.filter("reset").iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["new_session"]);
    }

    #[test]
    fn ranking_prefers_word_start_and_contiguous_matches() {
        let mut r = Registry::new();
        // "cp" as a contiguous word-initial match ("Command Palette") should
        // outrank a scattered match ("Copy Path" -> C..P is also word-initial,
        // but let's use a clearly scattered one).
        r.push(Action::new("scatter", "Crop Preview")); // c...p scattered-ish
        r.push(Action::new("initials", "Command Palette")); // word initials c + p
        let ranked: Vec<_> = r.filter("cp").iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ranked, ["initials", "scatter"]);
    }

    #[test]
    fn exact_prefix_outranks_midword() {
        let mut r = Registry::new();
        r.push(Action::new("mid", "Reopen")); // "open" starts mid-word
        r.push(Action::new("lead", "Open File")); // "open" at the very start
        let ranked: Vec<_> = r.filter("open").iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ranked, ["lead", "mid"]);
    }

    #[test]
    fn ties_keep_insertion_order() {
        let mut r = Registry::new();
        r.push(Action::new("a", "Run Alpha"));
        r.push(Action::new("b", "Run Beta"));
        // "run" scores identically for both; insertion order breaks the tie.
        let ranked: Vec<_> = r.filter("run").iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ranked, ["a", "b"]);
    }

    #[test]
    fn lookup_binding_resolves_dispatch() {
        let r = sample();
        let action = r.lookup_binding(&KeyChord::ctrl('p')).unwrap();
        assert_eq!(action.id, "palette");
        assert!(r.lookup_binding(&KeyChord::ctrl('z')).is_none());
    }

    #[test]
    fn by_id_and_needs_arg_flags() {
        let r = sample();
        assert!(r.by_id("open_file").unwrap().needs_arg);
        assert!(!r.by_id("palette").unwrap().needs_arg);
        assert!(r.by_id("missing").is_none());
    }

    #[test]
    fn chord_display_labels() {
        assert_eq!(KeyChord::ctrl('p').to_string(), "Ctrl+P");
        assert_eq!(KeyChord::plain(KeyCode::Tab).to_string(), "Tab");
        assert_eq!(
            KeyChord::new(KeyCode::Enter, KeyModifiers::ALT).to_string(),
            "Alt+Enter"
        );
        assert_eq!(KeyChord::plain(KeyCode::Right).to_string(), "Right");
    }

    #[test]
    fn non_subsequence_scores_none() {
        assert_eq!(fuzzy_score("Open File", "xyz"), None);
        assert!(fuzzy_score("Open File", "of").is_some());
        // Empty needle trivially matches with a neutral score.
        assert_eq!(fuzzy_score("anything", ""), Some(0));
    }
}
