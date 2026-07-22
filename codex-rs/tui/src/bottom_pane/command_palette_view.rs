//! Ctrl+P command palette: a fuzzy-searchable list of every slash command the
//! `/` popup offers, shown as a modal bottom-pane view.
//!
//! The list of commands comes from the exact same construction as
//! [`super::command_popup::CommandPopup`] (same availability flags, same
//! alias/debug filtering), and ranking is delegated to the pure
//! [`crate::action_registry::Registry`] fuzzy scorer (id = command name,
//! title = command description).
//!
//! Dispatch reuses the `/` popup's code path: selecting a command emits
//! [`AppEvent::CommandPaletteSelection`], which `ChatWidget` routes through the
//! same `handle_slash_command_dispatch` / `handle_service_tier_command_dispatch`
//! functions that consume `InputResult::Command` / `InputResult::ServiceTierCommand`
//! from the popup. Commands that take inline args are not executed directly;
//! `ChatWidget` inserts `/name ` into the composer, mirroring the popup's
//! completion behavior.

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

use crate::action_registry::Action;
use crate::action_registry::Registry;
use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::render::renderable::Renderable;

use super::CancellationEvent;
use super::bottom_pane_view::BottomPaneView;
use super::bottom_pane_view::ViewCompletion;
use super::command_popup::CommandItem;
use super::popup_consts::MAX_POPUP_ROWS;
use super::scroll_state::ScrollState;
use super::selection_popup_common::ColumnWidthConfig;
use super::selection_popup_common::ColumnWidthMode;
use super::selection_popup_common::GenericDisplayRow;
use super::selection_popup_common::measure_rows_height_with_col_width_mode;
use super::selection_popup_common::render_rows_with_col_width_mode;

const PALETTE_COLUMN_WIDTH: ColumnWidthConfig = ColumnWidthConfig::new(
    ColumnWidthMode::AutoAllRows,
    /*name_column_width*/ None,
);

/// Modal fuzzy command palette over the slash-command registry.
pub(crate) struct CommandPaletteView {
    /// Palette entries in `/` popup presentation order.
    items: Vec<CommandItem>,
    /// Pure fuzzy-ranking registry built from `items` (id = command name,
    /// title = description).
    registry: Registry,
    /// Current typed filter.
    query: String,
    state: ScrollState,
    app_event_tx: AppEventSender,
    completion: Option<ViewCompletion>,
}

impl CommandPaletteView {
    pub(crate) fn new(items: Vec<CommandItem>, app_event_tx: AppEventSender) -> Self {
        let mut registry = Registry::new();
        for item in &items {
            registry.push(Action::new(
                item.command().to_string(),
                item.description().to_string(),
            ));
        }
        let mut view = Self {
            items,
            registry,
            query: String::new(),
            state: ScrollState::new(),
            app_event_tx,
            completion: None,
        };
        view.reset_selection();
        view
    }

    /// Items matching the current query, best match first. An empty query
    /// preserves the `/` popup's presentation order.
    pub(crate) fn filtered_items(&self) -> Vec<CommandItem> {
        if self.query.trim().is_empty() {
            return self.items.clone();
        }
        self.registry
            .filter(&self.query)
            .into_iter()
            .filter_map(|action| {
                self.items
                    .iter()
                    .find(|item| item.command() == action.id)
                    .cloned()
            })
            .collect()
    }

    pub(crate) fn selected_item(&self) -> Option<CommandItem> {
        let matches = self.filtered_items();
        self.state
            .selected_idx
            .and_then(|idx| matches.get(idx).cloned())
    }

    /// Select the top-ranked row (if any) and rewind scrolling.
    fn reset_selection(&mut self) {
        let len = self.filtered_items().len();
        self.state.reset();
        if len > 0 {
            self.state.selected_idx = Some(0);
        }
        self.state.ensure_visible(len, MAX_POPUP_ROWS.min(len));
    }

    fn move_up(&mut self) {
        let len = self.filtered_items().len();
        self.state.move_up_wrap(len);
        self.state.ensure_visible(len, MAX_POPUP_ROWS.min(len));
    }

    fn move_down(&mut self) {
        let len = self.filtered_items().len();
        self.state.move_down_wrap(len);
        self.state.ensure_visible(len, MAX_POPUP_ROWS.min(len));
    }

    /// Dispatch the selected command through the same path as the `/` popup
    /// and close the palette.
    fn accept_selection(&mut self) {
        if let Some(item) = self.selected_item() {
            self.app_event_tx
                .send(AppEvent::CommandPaletteSelection(item));
            self.completion = Some(ViewCompletion::Accepted);
        }
    }

    fn rows(&self) -> Vec<GenericDisplayRow> {
        self.filtered_items()
            .into_iter()
            .map(|item| GenericDisplayRow {
                name: format!("/{}", item.command()),
                name_prefix_spans: Vec::new(),
                match_indices: None,
                display_shortcut: None,
                description: Some(item.description().to_string()),
                category_tag: None,
                wrap_indent: None,
                is_disabled: false,
                disabled_reason: None,
            })
            .collect()
    }

    fn query_line(&self) -> Line<'static> {
        let mut spans: Vec<Span<'static>> = vec!["▌ ".cyan(), "› ".dim()];
        if self.query.is_empty() {
            spans.push("type to search commands".to_string().dim());
        } else {
            spans.push(self.query.clone().into());
        }
        Line::from(spans)
    }
}

impl BottomPaneView for CommandPaletteView {
    fn handle_key_event(&mut self, key_event: KeyEvent) {
        match key_event {
            KeyEvent {
                code: KeyCode::Esc, ..
            } => {
                self.completion = Some(ViewCompletion::Cancelled);
            }
            KeyEvent {
                code: KeyCode::Up, ..
            }
            | KeyEvent {
                code: KeyCode::Char('p'),
                modifiers: KeyModifiers::CONTROL,
                ..
            } => self.move_up(),
            KeyEvent {
                code: KeyCode::Down,
                ..
            }
            | KeyEvent {
                code: KeyCode::Char('n'),
                modifiers: KeyModifiers::CONTROL,
                ..
            } => self.move_down(),
            KeyEvent {
                code: KeyCode::Enter,
                modifiers: KeyModifiers::NONE,
                ..
            }
            | KeyEvent {
                code: KeyCode::Tab, ..
            } => self.accept_selection(),
            KeyEvent {
                code: KeyCode::Backspace,
                ..
            } => {
                if self.query.pop().is_some() {
                    self.reset_selection();
                }
            }
            KeyEvent {
                code: KeyCode::Char(c),
                modifiers,
                ..
            } if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                self.query.push(c);
                self.reset_selection();
            }
            _ => {}
        }
    }

    fn is_complete(&self) -> bool {
        self.completion.is_some()
    }

    fn completion(&self) -> Option<ViewCompletion> {
        self.completion
    }

    fn on_ctrl_c(&mut self) -> CancellationEvent {
        self.completion = Some(ViewCompletion::Cancelled);
        CancellationEvent::Handled
    }
}

impl Renderable for CommandPaletteView {
    fn desired_height(&self, width: u16) -> u16 {
        let rows_height = measure_rows_height_with_col_width_mode(
            &self.rows(),
            &self.state,
            MAX_POPUP_ROWS,
            width,
            PALETTE_COLUMN_WIDTH,
        );
        // Title line + query line + rows.
        2u16.saturating_add(rows_height)
    }

    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width == 0 {
            return;
        }

        let title_area = Rect {
            x: area.x,
            y: area.y,
            width: area.width,
            height: 1,
        };
        Paragraph::new(Line::from(vec!["▌ ".cyan(), "Command Palette".bold()]))
            .render(title_area, buf);

        if area.height < 2 {
            return;
        }
        let query_area = Rect {
            x: area.x,
            y: area.y.saturating_add(1),
            width: area.width,
            height: 1,
        };
        Paragraph::new(self.query_line()).render(query_area, buf);

        if area.height < 3 {
            return;
        }
        let rows_area = Rect {
            x: area.x.saturating_add(2),
            y: area.y.saturating_add(2),
            width: area.width.saturating_sub(2),
            height: area.height.saturating_sub(2),
        };
        render_rows_with_col_width_mode(
            rows_area,
            buf,
            &self.rows(),
            &self.state,
            MAX_POPUP_ROWS,
            "no matching commands",
            PALETTE_COLUMN_WIDTH,
        );
    }

    fn cursor_pos(&self, area: Rect) -> Option<(u16, u16)> {
        if area.height < 2 {
            return None;
        }
        // "▌ › " prefix is 4 cells wide; the query is typed ASCII in practice.
        let x = area
            .x
            .saturating_add(4)
            .saturating_add(self.query.chars().count() as u16)
            .min(area.x.saturating_add(area.width.saturating_sub(1)));
        Some((x, area.y.saturating_add(1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_event::AppEvent;
    use crate::bottom_pane::command_popup::CommandPopup;
    use crate::bottom_pane::command_popup::CommandPopupFlags;
    use crate::slash_command::SlashCommand;
    use pretty_assertions::assert_eq;
    use tokio::sync::mpsc::unbounded_channel;

    fn default_items() -> Vec<CommandItem> {
        CommandPopup::new(CommandPopupFlags::default(), Vec::new()).palette_items()
    }

    fn test_view() -> (
        CommandPaletteView,
        tokio::sync::mpsc::UnboundedReceiver<AppEvent>,
    ) {
        let (tx, rx) = unbounded_channel::<AppEvent>();
        let view = CommandPaletteView::new(default_items(), AppEventSender::new(tx));
        (view, rx)
    }

    fn type_str(view: &mut CommandPaletteView, text: &str) {
        for c in text.chars() {
            view.handle_key_event(KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE));
        }
    }

    #[test]
    fn typing_mod_ranks_model_first() {
        let (mut view, _rx) = test_view();
        type_str(&mut view, "mod");
        let first = view.filtered_items().into_iter().next();
        assert_eq!(first, Some(CommandItem::Builtin(SlashCommand::Model)));
        // The top-ranked row is selected by default.
        assert_eq!(
            view.selected_item(),
            Some(CommandItem::Builtin(SlashCommand::Model))
        );
    }

    #[test]
    fn fuzzy_subsequence_matches_and_filters() {
        let (mut view, _rx) = test_view();
        // "dff" is a subsequence of "diff" (no prefix match), so /diff stays in.
        type_str(&mut view, "dff");
        let items = view.filtered_items();
        assert!(items.contains(&CommandItem::Builtin(SlashCommand::Diff)));
        // Commands whose name/description contain no d..f..f subsequence drop out.
        assert!(!items.contains(&CommandItem::Builtin(SlashCommand::Compact)));
    }

    #[test]
    fn empty_query_lists_same_items_as_slash_popup_default_view() {
        let (view, _rx) = test_view();
        assert_eq!(view.filtered_items(), default_items());
    }

    #[test]
    fn selection_clamps_when_filter_narrows_list() {
        let (mut view, _rx) = test_view();
        for _ in 0..5 {
            view.handle_key_event(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        }
        assert_eq!(view.state.selected_idx, Some(5));

        type_str(&mut view, "diff");
        // Narrowing the filter resets selection to the top-ranked match.
        assert_eq!(view.state.selected_idx, Some(0));
        assert_eq!(view.state.scroll_top, 0);
        assert_eq!(
            view.selected_item(),
            Some(CommandItem::Builtin(SlashCommand::Diff))
        );
    }

    #[test]
    fn selection_wraps_at_list_edges() {
        let (mut view, _rx) = test_view();
        let len = view.filtered_items().len();
        assert!(len > 1);
        view.handle_key_event(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(view.state.selected_idx, Some(len - 1));
        view.handle_key_event(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(view.state.selected_idx, Some(0));
    }

    #[test]
    fn enter_dispatches_same_command_item_as_command_popup() {
        // What would the `/` popup dispatch for "/diff" + Enter? Its Enter
        // handler emits `InputResult::Command(selected_item)`.
        let mut popup = CommandPopup::new(CommandPopupFlags::default(), Vec::new());
        popup.on_composer_text_change("/diff".to_string());
        let popup_selected = popup.selected_item().expect("popup selects /diff");

        // The palette must hand the identical CommandItem to the identical
        // dispatch path (AppEvent::CommandPaletteSelection -> ChatWidget
        // handle_slash_command_dispatch).
        let (mut view, mut rx) = test_view();
        type_str(&mut view, "diff");
        view.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        match rx.try_recv() {
            Ok(AppEvent::CommandPaletteSelection(item)) => {
                assert_eq!(item, popup_selected);
                assert_eq!(item, CommandItem::Builtin(SlashCommand::Diff));
            }
            other => panic!("expected CommandPaletteSelection event, got {other:?}"),
        }
        assert!(view.is_complete());
        assert_eq!(view.completion(), Some(ViewCompletion::Accepted));
    }

    #[test]
    fn enter_on_inline_arg_command_emits_selection_for_composer_insertion() {
        let (mut view, mut rx) = test_view();
        type_str(&mut view, "review");
        view.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));

        match rx.try_recv() {
            Ok(AppEvent::CommandPaletteSelection(CommandItem::Builtin(cmd))) => {
                assert_eq!(cmd, SlashCommand::Review);
                // ChatWidget uses this flag to insert "/review " into the
                // composer instead of executing, matching popup completion.
                assert!(cmd.supports_inline_args());
            }
            other => panic!("expected CommandPaletteSelection event, got {other:?}"),
        }
        assert!(view.is_complete());
    }

    #[test]
    fn esc_cancels_without_dispatch() {
        let (mut view, mut rx) = test_view();
        type_str(&mut view, "model");
        view.handle_key_event(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(view.completion(), Some(ViewCompletion::Cancelled));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn no_match_query_has_no_selection_and_enter_is_noop() {
        let (mut view, mut rx) = test_view();
        type_str(&mut view, "zzzzqqqq");
        assert!(view.filtered_items().is_empty());
        assert_eq!(view.selected_item(), None);
        view.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert!(!view.is_complete());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn command_palette_filter_snapshot() {
        let (mut view, _rx) = test_view();
        type_str(&mut view, "mo");

        let width = 72;
        let height = view.desired_height(width);
        let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
        let mut buf = Buffer::empty(area);
        view.render(area, &mut buf);

        insta::assert_snapshot!("command_palette_mo", format!("{buf:?}"));
    }
}
