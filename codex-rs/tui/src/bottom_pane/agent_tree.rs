//! The resident panel above the composer: what is planned, and who is working.
//!
//! Both halves already existed but only as things that scrolled away — the todo
//! list as a one-shot `update_plan` transcript card, sub-agent activity as
//! another. Neither survived the next message, so a user could not answer "what
//! is running right now" without re-running a command. Keeping one block
//! resident answers it continuously.
//!
//! Navigation is the reason this is a widget rather than a popup: reaching a
//! running agent should not require opening anything.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;
use ratatui::widgets::Widget;

use crate::render::renderable::Renderable;

/// One todo item, mirroring `update_plan`'s three states.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TodoRow {
    pub(crate) text: String,
    pub(crate) status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    fn marker(self) -> Span<'static> {
        match self {
            Self::Pending => "☐ ".dim(),
            Self::InProgress => "▶ ".cyan(),
            Self::Completed => "☑ ".green(),
        }
    }
}

/// What a navigable row points at.
///
/// Only threads in this process. Peers were deliberately left out: this panel
/// answers "what is my session doing", and another user's session has no place
/// in that answer — it has its own surfaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TreeTarget {
    Thread(codex_protocol::ThreadId),
}

/// One navigable row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentRow {
    pub(crate) target: TreeTarget,
    pub(crate) label: String,
    /// What it is doing, when known.
    pub(crate) activity: Option<String>,
    pub(crate) is_running: bool,
    pub(crate) is_active: bool,
    /// Rendered elapsed time, for example `5m49s`.
    pub(crate) elapsed: Option<String>,
    pub(crate) tokens: Option<u64>,
}

/// Which half of the bottom pane owns the arrow keys.
///
/// The composer keeps them by default. Handing them to the tree costs history
/// recall, which is the most-used binding in the TUI, so the tree may only take
/// them when the composer has nothing to lose: an empty draft and at least one
/// row to move through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum PaneFocus {
    #[default]
    Composer,
    AgentTree,
}

/// The resident panel's state.
#[derive(Debug, Default)]
pub(crate) struct AgentTree {
    todos: Vec<TodoRow>,
    agents: Vec<AgentRow>,
    focus: PaneFocus,
    selected: usize,
}

impl AgentTree {
    /// Replaces the todo list. Returns whether anything changed.
    pub(crate) fn set_todos(&mut self, todos: Vec<TodoRow>) -> bool {
        if self.todos == todos {
            return false;
        }
        self.todos = todos;
        true
    }

    /// Replaces the agent and peer rows, keeping the selection on the same
    /// target where possible so a refresh does not move the cursor under the
    /// user's fingers.
    pub(crate) fn set_agents(&mut self, agents: Vec<AgentRow>) -> bool {
        if self.agents == agents {
            return false;
        }
        let selected_target = self.agents.get(self.selected).map(|row| row.target.clone());
        self.agents = agents;
        self.selected = selected_target
            .and_then(|target| self.agents.iter().position(|row| row.target == target))
            .unwrap_or(0);
        if self.focus == PaneFocus::AgentTree && self.agents.is_empty() {
            // Focus cannot rest on nothing.
            self.focus = PaneFocus::Composer;
        }
        true
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.todos.is_empty() && self.agents.is_empty()
    }

    pub(crate) fn focus(&self) -> PaneFocus {
        self.focus
    }

    pub(crate) fn selected_target(&self) -> Option<&TreeTarget> {
        self.agents.get(self.selected).map(|row| &row.target)
    }

    /// Tries to move focus into the tree.
    ///
    /// Refuses when there is nothing to select, so a stray arrow key in an
    /// empty session still recalls history.
    pub(crate) fn focus_tree(&mut self) -> bool {
        if self.agents.is_empty() {
            return false;
        }
        self.focus = PaneFocus::AgentTree;
        self.selected = 0;
        true
    }

    pub(crate) fn focus_composer(&mut self) {
        self.focus = PaneFocus::Composer;
    }

    /// Moves the cursor up, reporting whether it had anywhere to go.
    ///
    /// `false` means the caller should hand focus back to the composer: the
    /// user is walking up out of the panel the way they came in.
    pub(crate) fn select_previous(&mut self) -> bool {
        if self.selected == 0 {
            return false;
        }
        self.selected -= 1;
        true
    }

    pub(crate) fn select_next(&mut self) {
        let last = self.agents.len().saturating_sub(1);
        self.selected = (self.selected + 1).min(last);
    }

    /// Right-aligns the elapsed and token columns so they form a readable
    /// gutter instead of drifting with each row's activity text.
    fn lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = Vec::new();

        for todo in &self.todos {
            let text = if todo.status == TodoStatus::Completed {
                todo.text.clone().dim().crossed_out()
            } else {
                todo.text.clone().into()
            };
            lines.push(Line::from(vec!["  ".into(), todo.status.marker(), text]));
        }

        if !self.todos.is_empty() && !self.agents.is_empty() {
            lines.push("".into());
        }

        for (index, agent) in self.agents.iter().enumerate() {
            let focused = self.focus == PaneFocus::AgentTree && index == self.selected;
            let mut spans: Vec<Span<'static>> =
                vec![if focused { "› ".cyan() } else { "  ".into() }];
            spans.push(if agent.is_running {
                "◉ ".green()
            } else if agent.is_active {
                "● ".cyan()
            } else {
                "◯ ".dim()
            });
            spans.push(if focused {
                agent.label.clone().bold()
            } else {
                agent.label.clone().into()
            });
            if let Some(activity) = agent.activity.as_ref() {
                spans.push("  ".into());
                spans.push(activity.clone().dim());
            }

            let metadata = match (agent.elapsed.as_ref(), agent.tokens) {
                (Some(elapsed), Some(tokens)) => {
                    Some(format!("{elapsed} · {}", format_tokens(tokens)))
                }
                (Some(elapsed), None) => Some(elapsed.clone()),
                (None, Some(tokens)) => Some(format_tokens(tokens)),
                (None, None) => None,
            };
            if let Some(metadata) = metadata {
                let used: usize = spans.iter().map(|span| span.content.chars().count()).sum();
                // Two spaces is the floor: without it a long activity line would
                // run straight into the numbers.
                let gap = usize::from(width)
                    .saturating_sub(used + metadata.chars().count())
                    .max(2);
                spans.push(" ".repeat(gap).into());
                spans.push(metadata.dim());
            }
            lines.push(Line::from(spans));
        }

        if self.focus == PaneFocus::AgentTree {
            lines.push(Line::from(vec![
                "    ".into(),
                "↑↓ select · enter open · esc back to input".dim(),
            ]));
        }

        lines
    }
}

/// Renders a token count the way a status line should: short, and never
/// pretending to more precision than matters.
fn format_tokens(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("↓ {:.1}M tokens", tokens as f64 / 1_000_000.0)
    } else if tokens >= 1_000 {
        format!("↓ {:.1}k tokens", tokens as f64 / 1_000.0)
    } else {
        format!("↓ {tokens} tokens")
    }
}

impl Renderable for AgentTree {
    fn desired_height(&self, width: u16) -> u16 {
        self.lines(width).len() as u16
    }

    fn render(&self, area: Rect, buf: &mut Buffer) {
        Paragraph::new(self.lines(area.width)).render(area, buf);
    }
}

#[cfg(test)]
#[path = "agent_tree_tests.rs"]
mod agent_tree_tests;
