//! `?` which-key overlay: the keybindings reachable from the plain composer.
//!
//! Triggered by pressing `?` on an EMPTY composer (lazygit/k9s convention) via
//! `ChatWidget::handle_key_event` -> `BottomPane::open_which_key`; typing `?`
//! into a non-empty draft is unaffected. The rows are derived from the real
//! sources the TUI honors in that state:
//!
//! * the resolved [`RuntimeKeymap`] (composer / editor / chat / app contexts),
//!   so user rebindings show up automatically, and
//! * the hardcoded `chatwidget/interaction.rs` interceptors (Ctrl+P palette,
//!   Ctrl+C / Ctrl+D quit, Ctrl+V image paste, BackTab collaboration mode) plus
//!   the composer's popup trigger characters (`/`, `@`).
//!
//! Close semantics: `Esc` closes; a printable character closes AND re-types
//! itself into the composer through [`AppEvent::InsertComposerText`] (so `?`
//! twice yields a literal `?`); `Left`/`Right`/`PgUp`/`PgDn` navigate pages
//! when there is more than one; any other key just closes (non-printable keys
//! are swallowed — re-dispatching raw key events is not supported by the app
//! event loop).
//!
//! Rows reuse [`crate::which_key::WhichKeyRow`]; the mode-stack layering of
//! `which_key.rs` is not exercised here because the plain composer is a single
//! context (no sub-modes yet), and its `pages()` helper is replaced by
//! group-aware pagination that keeps headers with their rows.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;

use crate::action_registry::KeyChord;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::key_hint;
use crate::key_hint::KeyBinding;
use crate::keymap::RuntimeKeymap;
use crate::keymap::primary_binding;
use crate::render::renderable::Renderable;
use crate::which_key::WhichKeyRow;

use super::CancellationEvent;
use super::bottom_pane_view::BottomPaneView;
use super::bottom_pane_view::ViewCompletion;

/// Maximum content lines (group headers + binding rows) per overlay page.
const LINES_PER_PAGE: usize = 12;

/// A named group of which-key rows (Conversation / Editing / ...).
pub(crate) struct WhichKeyGroup {
    pub(crate) name: &'static str,
    pub(crate) rows: Vec<WhichKeyRow>,
}

/// Primary binding of `bindings` as a display chord, if the action is bound.
fn chord_of(bindings: &[KeyBinding]) -> Option<KeyChord> {
    primary_binding(bindings).map(|binding| {
        let (code, mods) = binding.parts();
        KeyChord::new(code, mods)
    })
}

/// Like [`chord_of`], but prefer `preferred` when it is among the bindings.
///
/// Used where the primary (first) binding is an emacs-style alias while a
/// later compatibility variant is the one users actually recognize (e.g.
/// `insert_newline` lists `Ctrl+J` first but `Shift+Enter` is the familiar
/// chord).
fn chord_preferring(bindings: &[KeyBinding], preferred: KeyBinding) -> Option<KeyChord> {
    if bindings.contains(&preferred) {
        let (code, mods) = preferred.parts();
        Some(KeyChord::new(code, mods))
    } else {
        chord_of(bindings)
    }
}

fn push_row(rows: &mut Vec<WhichKeyRow>, chord: Option<KeyChord>, label: &str) {
    if let Some(chord) = chord {
        rows.push(WhichKeyRow::new(chord, label));
    }
}

/// The grouped binding table for the plain-composer context.
///
/// Keymap-derived rows follow the resolved [`RuntimeKeymap`] (and silently drop
/// out if the user unbound the action); the remaining rows mirror the hardcoded
/// interceptors in `chatwidget/interaction.rs` and the composer's popup
/// triggers, which are not keymap-configurable today.
pub(crate) fn composer_which_key_groups(keymap: &RuntimeKeymap) -> Vec<WhichKeyGroup> {
    let mut conversation = Vec::new();
    push_row(
        &mut conversation,
        chord_of(&keymap.composer.submit),
        "Send message",
    );
    push_row(
        &mut conversation,
        chord_of(&keymap.composer.queue),
        "Queue message while a task runs",
    );
    push_row(
        &mut conversation,
        chord_of(&keymap.chat.interrupt_turn),
        "Interrupt task / edit previous message",
    );
    conversation.push(WhichKeyRow::new(
        KeyChord::ctrl('c'),
        "Interrupt; press twice to quit",
    ));
    conversation.push(WhichKeyRow::new(
        KeyChord::ctrl('d'),
        "Quit (when composer is empty)",
    ));
    push_row(
        &mut conversation,
        chord_of(&keymap.chat.edit_queued_message),
        "Edit most recently queued message",
    );
    push_row(
        &mut conversation,
        chord_of(&keymap.app.copy),
        "Copy last response",
    );

    let mut editing = Vec::new();
    push_row(
        &mut editing,
        chord_preferring(
            &keymap.editor.insert_newline,
            key_hint::shift(KeyCode::Enter),
        ),
        "Insert newline",
    );
    push_row(
        &mut editing,
        chord_of(&keymap.app.open_external_editor),
        "Edit draft in external editor",
    );
    editing.push(WhichKeyRow::new(
        KeyChord::ctrl('v'),
        "Paste image from clipboard",
    ));
    push_row(
        &mut editing,
        chord_of(&keymap.editor.kill_line_end),
        "Delete to end of line",
    );
    push_row(
        &mut editing,
        chord_of(&keymap.editor.kill_line_start),
        "Delete to start of line",
    );
    push_row(
        &mut editing,
        chord_of(&keymap.editor.delete_backward_word),
        "Delete previous word",
    );

    let mut navigation = Vec::new();
    navigation.push(WhichKeyRow::new(
        KeyChord::plain(KeyCode::Up),
        "Browse input history",
    ));
    push_row(
        &mut navigation,
        chord_of(&keymap.composer.history_search_previous),
        "Search input history",
    );
    push_row(
        &mut navigation,
        chord_of(&keymap.app.open_transcript),
        "Show full transcript",
    );
    push_row(
        &mut navigation,
        chord_of(&keymap.app.clear_terminal),
        "Clear screen",
    );

    let mut other = Vec::new();
    other.push(WhichKeyRow::new(
        KeyChord::ctrl('p'),
        "Open command palette",
    ));
    other.push(WhichKeyRow::new(
        KeyChord::plain(KeyCode::Char('/')),
        "Slash commands",
    ));
    other.push(WhichKeyRow::new(
        KeyChord::plain(KeyCode::Char('@')),
        "Mention a file",
    ));
    other.push(WhichKeyRow::new(
        KeyChord::plain(KeyCode::BackTab),
        "Cycle collaboration mode",
    ));
    push_row(
        &mut other,
        chord_of(&keymap.chat.increase_reasoning_effort),
        "Increase reasoning effort",
    );
    push_row(
        &mut other,
        chord_of(&keymap.chat.decrease_reasoning_effort),
        "Decrease reasoning effort",
    );
    other.push(WhichKeyRow::new(
        KeyChord::plain(KeyCode::Char('?')),
        "This help (again: close and type '?')",
    ));

    let mut groups = vec![
        WhichKeyGroup {
            name: "Conversation",
            rows: conversation,
        },
        WhichKeyGroup {
            name: "Editing",
            rows: editing,
        },
        WhichKeyGroup {
            name: "Navigation",
            rows: navigation,
        },
        WhichKeyGroup {
            name: "Other",
            rows: other,
        },
    ];
    groups.retain(|group| !group.rows.is_empty());
    groups
}

/// One display line of a paginated overlay page.
#[derive(Clone, Debug, Eq, PartialEq)]
enum PageLine {
    Header(String),
    Row { chord: String, label: String },
}

/// Split groups into pages of at most `lines_per_page` lines, keeping group
/// headers attached to their rows.
///
/// Whole groups are packed greedily; a group larger than a page is split with
/// its header repeated as `"<name> (cont.)"`. A header is never emitted as the
/// last line of a page.
fn paginate(groups: &[WhichKeyGroup], lines_per_page: usize) -> Vec<Vec<PageLine>> {
    let lines_per_page = lines_per_page.max(2);
    let mut pages: Vec<Vec<PageLine>> = Vec::new();
    let mut current: Vec<PageLine> = Vec::new();

    for group in groups {
        let block_len = group.rows.len() + 1;
        // Start a fresh page when the whole group would fit there but not here.
        if !current.is_empty()
            && current.len() + block_len > lines_per_page
            && block_len <= lines_per_page
        {
            pages.push(std::mem::take(&mut current));
        }

        let mut header = group.name.to_string();
        let mut rows = group.rows.iter().peekable();
        while rows.peek().is_some() {
            // Keep room for at least one row under the header.
            if current.len() + 1 >= lines_per_page {
                pages.push(std::mem::take(&mut current));
            }
            current.push(PageLine::Header(header.clone()));
            while rows.peek().is_some() && current.len() < lines_per_page {
                let row = rows.next().expect("peeked row");
                current.push(PageLine::Row {
                    chord: row.chord.to_string(),
                    label: row.label.clone(),
                });
            }
            if rows.peek().is_some() {
                pages.push(std::mem::take(&mut current));
                header = format!("{} (cont.)", group.name);
            }
        }
    }
    if !current.is_empty() {
        pages.push(current);
    }
    pages
}

/// Modal which-key overlay listing the plain-composer bindings, paged.
pub(crate) struct WhichKeyView {
    pages: Vec<Vec<PageLine>>,
    page: usize,
    /// Width of the chord column (widest chord label across all pages).
    chord_width: usize,
    app_event_tx: AppEventSender,
    completion: Option<ViewCompletion>,
}

impl WhichKeyView {
    pub(crate) fn new(groups: Vec<WhichKeyGroup>, app_event_tx: AppEventSender) -> Self {
        let pages = paginate(&groups, LINES_PER_PAGE);
        let chord_width = groups
            .iter()
            .flat_map(|group| &group.rows)
            .map(|row| row.chord.to_string().chars().count())
            .max()
            .unwrap_or(0);
        Self {
            pages,
            page: 0,
            chord_width,
            app_event_tx,
            completion: None,
        }
    }

    fn close(&mut self) {
        self.completion = Some(ViewCompletion::Cancelled);
    }

    fn current_page(&self) -> &[PageLine] {
        self.pages.get(self.page).map(Vec::as_slice).unwrap_or(&[])
    }

    fn title_line(&self) -> Line<'static> {
        let mut spans: Vec<Span<'static>> = vec!["▌ ".cyan(), "Keyboard Shortcuts".bold()];
        if self.pages.len() > 1 {
            spans.push(format!("  page {}/{}", self.page + 1, self.pages.len()).dim());
        }
        Line::from(spans)
    }

    fn hint_line(&self) -> Line<'static> {
        let mut hint = String::new();
        if self.pages.len() > 1 {
            hint.push_str("←/→ page  ·  ");
        }
        hint.push_str("Esc close  ·  typing closes and inserts the key");
        Line::from(hint.dim())
    }

    fn content_lines(&self) -> Vec<Line<'static>> {
        self.current_page()
            .iter()
            .map(|line| match line {
                PageLine::Header(name) => Line::from(format!("  {name}").bold()),
                PageLine::Row { chord, label } => Line::from(vec![
                    "    ".into(),
                    format!("{chord:>width$}", width = self.chord_width).cyan(),
                    "  ".into(),
                    label.clone().into(),
                ]),
            })
            .collect()
    }
}

impl BottomPaneView for WhichKeyView {
    fn handle_key_event(&mut self, key_event: KeyEvent) {
        let multi_page = self.pages.len() > 1;
        match key_event.code {
            KeyCode::Esc => self.close(),
            KeyCode::Left | KeyCode::PageUp if multi_page => {
                self.page = self.page.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::PageDown if multi_page => {
                self.page = (self.page + 1).min(self.pages.len().saturating_sub(1));
            }
            KeyCode::Char(c)
                if !key_event
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                // Close AND re-type the character into the composer so the
                // keystroke is not swallowed ('?' twice types a literal '?').
                self.app_event_tx
                    .send(AppEvent::InsertComposerText(c.to_string()));
                self.close();
            }
            _ => self.close(),
        }
    }

    fn is_complete(&self) -> bool {
        self.completion.is_some()
    }

    fn completion(&self) -> Option<ViewCompletion> {
        self.completion
    }

    fn on_ctrl_c(&mut self) -> CancellationEvent {
        self.close();
        CancellationEvent::Handled
    }
}

impl Renderable for WhichKeyView {
    fn desired_height(&self, _width: u16) -> u16 {
        // Title + content lines + hint line.
        (self.current_page().len() as u16).saturating_add(2)
    }

    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }
        let mut lines = vec![self.title_line()];
        lines.extend(self.content_lines());
        lines.push(self.hint_line());
        Paragraph::new(lines).render(area, buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tokio::sync::mpsc::unbounded_channel;

    fn default_groups() -> Vec<WhichKeyGroup> {
        composer_which_key_groups(&RuntimeKeymap::defaults())
    }

    fn test_view() -> (WhichKeyView, tokio::sync::mpsc::UnboundedReceiver<AppEvent>) {
        let (tx, rx) = unbounded_channel::<AppEvent>();
        let view = WhichKeyView::new(default_groups(), AppEventSender::new(tx));
        (view, rx)
    }

    fn all_rows(groups: &[WhichKeyGroup]) -> Vec<(String, String)> {
        groups
            .iter()
            .flat_map(|group| &group.rows)
            .map(|row| (row.chord.to_string(), row.label.clone()))
            .collect()
    }

    fn press(view: &mut WhichKeyView, code: KeyCode) {
        view.handle_key_event(KeyEvent::new(code, KeyModifiers::NONE));
    }

    #[test]
    fn binding_table_contains_known_entries() {
        let rows = all_rows(&default_groups());
        assert!(
            (15..=30).contains(&rows.len()),
            "expected 15..=30 rows, got {}",
            rows.len()
        );
        let find = |chord: &str| {
            rows.iter()
                .find(|(c, _)| c == chord)
                .map(|(_, label)| label.clone())
        };
        assert_eq!(find("Ctrl+P").as_deref(), Some("Open command palette"));
        assert_eq!(find("Enter").as_deref(), Some("Send message"));
        // Interceptors and keymap-derived rows are both present.
        assert!(find("Ctrl+C").is_some());
        assert!(find("Esc").is_some());
    }

    #[test]
    fn groups_cover_the_four_categories_and_are_non_empty() {
        let groups = default_groups();
        let names: Vec<&str> = groups.iter().map(|group| group.name).collect();
        assert_eq!(names, ["Conversation", "Editing", "Navigation", "Other"]);
        for group in &groups {
            assert!(!group.rows.is_empty(), "group {} is empty", group.name);
        }
    }

    #[test]
    fn page_navigation_clamps_at_both_ends() {
        let (mut view, _rx) = test_view();
        assert!(view.pages.len() > 1, "default table should paginate");
        // Left below the first page clamps.
        press(&mut view, KeyCode::Left);
        assert_eq!(view.page, 0);
        assert!(!view.is_complete());
        // Right walks to the last page and clamps there.
        for _ in 0..view.pages.len() + 2 {
            press(&mut view, KeyCode::Right);
        }
        assert_eq!(view.page, view.pages.len() - 1);
        assert!(!view.is_complete());
        // PgUp/PgDn are aliases.
        press(&mut view, KeyCode::PageUp);
        assert_eq!(view.page, view.pages.len() - 2);
        press(&mut view, KeyCode::PageDown);
        assert_eq!(view.page, view.pages.len() - 1);
    }

    #[test]
    fn question_mark_closes_and_reinserts_a_literal_question_mark() {
        let (mut view, mut rx) = test_view();
        press(&mut view, KeyCode::Char('?'));
        assert!(view.is_complete());
        assert_eq!(view.completion(), Some(ViewCompletion::Cancelled));
        match rx.try_recv() {
            Ok(AppEvent::InsertComposerText(text)) => assert_eq!(text, "?"),
            other => panic!("expected InsertComposerText, got {other:?}"),
        }
    }

    #[test]
    fn esc_and_non_printable_keys_close_without_inserting() {
        let (mut view, mut rx) = test_view();
        press(&mut view, KeyCode::Esc);
        assert!(view.is_complete());
        assert!(rx.try_recv().is_err());

        let (mut view, mut rx) = test_view();
        press(&mut view, KeyCode::Enter);
        assert!(view.is_complete());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn printable_char_closes_and_is_retyped_into_the_composer() {
        let (mut view, mut rx) = test_view();
        press(&mut view, KeyCode::Char('h'));
        assert!(view.is_complete());
        match rx.try_recv() {
            Ok(AppEvent::InsertComposerText(text)) => assert_eq!(text, "h"),
            other => panic!("expected InsertComposerText, got {other:?}"),
        }
    }

    #[test]
    fn paginate_keeps_headers_with_rows_and_splits_oversized_groups() {
        let rows = (0..20)
            .map(|i| WhichKeyRow::new(KeyChord::ctrl(char::from(b'a' + i)), format!("Action {i}")))
            .collect();
        let groups = vec![WhichKeyGroup { name: "Big", rows }];
        let pages = paginate(&groups, 6);
        assert!(pages.len() > 1);
        for page in &pages {
            assert!(page.len() <= 6);
            // Every page starts with a header, and a header is never last.
            assert!(matches!(page.first(), Some(PageLine::Header(_))));
            assert!(!matches!(page.last(), Some(PageLine::Header(_))));
        }
        assert!(matches!(
            pages[1].first(),
            Some(PageLine::Header(name)) if name == "Big (cont.)"
        ));
        // No rows are lost across the split.
        let total_rows: usize = pages
            .iter()
            .flatten()
            .filter(|line| matches!(line, PageLine::Row { .. }))
            .count();
        assert_eq!(total_rows, 20);
    }

    #[test]
    fn which_key_overlay_snapshot() {
        let (view, _rx) = test_view();
        let width = 64;
        let height = view.desired_height(width);
        let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
        let mut buf = Buffer::empty(area);
        view.render(area, &mut buf);
        insta::assert_snapshot!("which_key_overlay", format!("{buf:?}"));
    }
}
