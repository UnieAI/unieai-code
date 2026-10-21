// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/tasks` (and `/ps`): this session's subagents and the commands left running.
//!
//! The resident agent tree answers "who is working" in one line per agent;
//! this view is the table behind it. Each subagent shows its status, how long
//! it has been at it, what it has cost, the model it runs on and what it did
//! last; each background command shows the same columns where they apply,
//! with the agent that started it in place of the last action. A row opens
//! (switch to the agent's thread, or page the command's recent output) or
//! stops (interrupt the agent, or terminate the command) — stopping always
//! asks first, through the confirmation list the app shows.
//!
//! The view is a snapshot: it closes when a row is opened or stopped, and the
//! app reopens it with fresh rows after a stop, so it never shows a stale
//! state for long.

use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthChar;
use unicode_width::UnicodeWidthStr;

use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::key_hint::KeyBindingListExt;
use crate::keymap::AgentsKeymap;
use crate::keymap::ListAction;
use crate::keymap::ListKeymap;
use crate::render::renderable::Renderable;

use super::CancellationEvent;
use super::agent_tree::TreeTarget;
use super::agent_tree::format_tokens;
use super::bottom_pane_view::BottomPaneView;

pub(crate) const TASKS_VIEW_ID: &str = "unieai-tasks";

/// Where a task is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskStatus {
    Running,
    Idle,
    Done,
}

impl TaskStatus {
    fn label(self) -> Span<'static> {
        match self {
            Self::Running => "running".green(),
            Self::Idle => "idle".cyan(),
            Self::Done => "done".dim(),
        }
    }
}

/// One row of the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskRow {
    pub(crate) target: TreeTarget,
    /// The agent's name, or the command line.
    pub(crate) label: String,
    pub(crate) status: TaskStatus,
    pub(crate) elapsed: Option<String>,
    pub(crate) tokens: Option<u64>,
    pub(crate) model: Option<String>,
    /// A subagent's last action, or the agent that started a command.
    pub(crate) detail: Option<String>,
}

impl TaskRow {
    fn is_command(&self) -> bool {
        matches!(self.target, TreeTarget::ExecSession { .. })
    }
}

pub(crate) struct TasksView {
    rows: Vec<TaskRow>,
    selected: usize,
    complete: bool,
    app_event_tx: AppEventSender,
    list_keymap: ListKeymap,
    agents_keymap: AgentsKeymap,
}

impl TasksView {
    pub(crate) fn new(
        rows: Vec<TaskRow>,
        app_event_tx: AppEventSender,
        list_keymap: ListKeymap,
        agents_keymap: AgentsKeymap,
    ) -> Self {
        // Subagents first, then commands, each in the order the app gave.
        let (mut ordered, commands): (Vec<_>, Vec<_>) =
            rows.into_iter().partition(|row| !row.is_command());
        ordered.extend(commands);
        Self {
            rows: ordered,
            selected: 0,
            complete: false,
            app_event_tx,
            list_keymap,
            agents_keymap,
        }
    }

    fn selected_row(&self) -> Option<&TaskRow> {
        self.rows.get(self.selected)
    }

    fn open_selected(&mut self) {
        let Some(row) = self.selected_row() else {
            return;
        };
        self.app_event_tx
            .send(AppEvent::OpenTask(row.target.clone()));
        self.complete = true;
    }

    fn stop_selected(&mut self) {
        let Some(row) = self.selected_row() else {
            return;
        };
        // Only something that is working can be stopped.
        if row.status != TaskStatus::Running {
            return;
        }
        self.app_event_tx.send(AppEvent::ConfirmStopTask {
            target: row.target.clone(),
            label: row.label.clone(),
            reopen_tasks: true,
        });
        self.complete = true;
    }

    fn move_by(&mut self, action: ListAction) {
        let last = self.rows.len().saturating_sub(1);
        self.selected = match action {
            ListAction::MoveUp => self.selected.saturating_sub(1),
            ListAction::MoveDown => (self.selected + 1).min(last),
            ListAction::PageUp | ListAction::JumpTop => 0,
            ListAction::PageDown | ListAction::JumpBottom => last,
            _ => self.selected,
        };
    }

    fn lines(&self, width: u16) -> Vec<Line<'static>> {
        let width = usize::from(width);
        let mut lines: Vec<Line<'static>> = vec![Line::from(vec![
            "Tasks".bold(),
            "  subagents and background commands".dim(),
        ])];
        lines.push("".into());
        if self.rows.is_empty() {
            lines.push(Line::from(
                "  No subagents or background commands in this session.".dim(),
            ));
            lines.push("".into());
            lines.push(Line::from("  esc close".dim()));
            return lines;
        }

        let label_width = self
            .rows
            .iter()
            .map(|row| row.label.width())
            .max()
            .unwrap_or(0)
            .clamp(8, 32);
        let mut section: Option<bool> = None;
        for (index, row) in self.rows.iter().enumerate() {
            if section != Some(row.is_command()) {
                if section.is_some() {
                    lines.push("".into());
                }
                section = Some(row.is_command());
                lines.push(Line::from(
                    if row.is_command() {
                        "  Background commands"
                    } else {
                        "  Subagents"
                    }
                    .dim(),
                ));
            }
            let focused = index == self.selected;
            let mut spans: Vec<Span<'static>> =
                vec![if focused { "› ".cyan() } else { "  ".into() }];
            spans.push(if row.is_command() {
                "$ ".dim()
            } else {
                match row.status {
                    TaskStatus::Running => "◉ ".green(),
                    TaskStatus::Idle => "● ".cyan(),
                    TaskStatus::Done => "◯ ".dim(),
                }
            });
            let label = pad(&truncate(&row.label, label_width), label_width);
            spans.push(if focused { label.bold() } else { label.into() });
            spans.push("  ".into());
            let status = row.status.label();
            let status_width = status.content.width();
            spans.push(status);
            spans.push(" ".repeat(8usize.saturating_sub(status_width)).into());
            let columns = [
                row.elapsed.clone(),
                row.tokens.map(format_tokens),
                row.model.clone(),
            ];
            let metadata: Vec<String> = columns.into_iter().flatten().collect();
            if !metadata.is_empty() {
                spans.push(metadata.join(" · ").dim());
            }
            if let Some(detail) = row.detail.as_ref() {
                spans.push("  ".into());
                spans.push(detail.clone().dim());
            }
            lines.push(clip(Line::from(spans), width));
        }

        lines.push("".into());
        let open = self
            .agents_keymap
            .resume
            .first()
            .map(|binding| binding.display_label())
            .unwrap_or_else(|| "o".to_string());
        let stop = self
            .agents_keymap
            .stop
            .first()
            .map(|binding| binding.display_label())
            .unwrap_or_else(|| "x".to_string());
        lines.push(Line::from(
            format!("  ↑↓ select · enter/{open} open · {stop} stop · esc close").dim(),
        ));
        lines
    }
}

/// `text` cut to `width` columns, with an ellipsis when it was longer.
fn truncate(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let w = ch.width().unwrap_or(0);
        if used + w + 1 > width {
            break;
        }
        out.push(ch);
        used += w;
    }
    out.push('…');
    out
}

fn pad(text: &str, width: usize) -> String {
    let fill = width.saturating_sub(text.width());
    format!("{text}{}", " ".repeat(fill))
}

/// A line cut to the view's width, so a long last action never wraps the table.
fn clip(line: Line<'static>, width: usize) -> Line<'static> {
    let mut used = 0;
    let mut spans = Vec::new();
    for span in line.spans {
        let w = span.content.width();
        if used + w <= width {
            used += w;
            spans.push(span);
            continue;
        }
        let room = width.saturating_sub(used);
        if room > 0 {
            let style = span.style;
            spans.push(Span::styled(truncate(&span.content, room), style));
        }
        break;
    }
    Line::from(spans)
}

impl BottomPaneView for TasksView {
    fn keymap_contexts(&self) -> crate::keymap::KeymapContextSet {
        crate::keymap::KeymapContextSet::new(crate::keymap::KeymapContext::List)
    }

    fn handle_key_event(&mut self, key_event: KeyEvent) {
        if let Some(action) = self.list_keymap.vertical_action_for(key_event) {
            self.move_by(action);
            return;
        }
        if self.list_keymap.accept.is_pressed(key_event)
            || self.agents_keymap.resume.is_pressed(key_event)
        {
            self.open_selected();
        } else if self.agents_keymap.stop.is_pressed(key_event) {
            self.stop_selected();
        } else if self.list_keymap.cancel.is_pressed(key_event) {
            self.complete = true;
        }
    }

    fn is_complete(&self) -> bool {
        self.complete
    }

    fn view_id(&self) -> Option<&'static str> {
        Some(TASKS_VIEW_ID)
    }

    fn selected_index(&self) -> Option<usize> {
        (!self.rows.is_empty()).then_some(self.selected)
    }

    fn on_ctrl_c(&mut self) -> CancellationEvent {
        self.complete = true;
        CancellationEvent::Handled
    }
}

impl Renderable for TasksView {
    fn desired_height(&self, width: u16) -> u16 {
        u16::try_from(self.lines(width).len()).unwrap_or(u16::MAX)
    }

    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.is_empty() {
            return;
        }
        Paragraph::new(self.lines(area.width)).render(area, buf);
    }
}

#[cfg(test)]
#[path = "tasks_view_tests.rs"]
mod tasks_view_tests;
