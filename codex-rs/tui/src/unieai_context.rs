// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/context` on the uac engine: what is using the context window.
//!
//! The uac server answers `unieai/context/read` with a breakdown that the
//! unieai-context-usage dsh plugin measures (system prompt, tool definitions,
//! instructions, skills, messages, tool results, free space, and where dsh
//! compacts). It is not a codex protocol method, so it goes out as raw
//! JSON-RPC, which only a remote app-server connection carries; the uac
//! engine always is one.

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::RequestId;
use codex_protocol::ThreadId;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::status::format_tokens_compact;

pub(crate) const CONTEXT_READ_METHOD: &str = "unieai/context/read";

/// Cells in the usage bar.
const BAR_WIDTH: usize = 40;
const LABEL_WIDTH: usize = 30;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextUsage {
    pub(crate) total_tokens: i64,
    #[serde(default)]
    pub(crate) calibrated: bool,
    #[serde(default)]
    pub(crate) context_window: Option<i64>,
    #[serde(default)]
    pub(crate) free_tokens: Option<i64>,
    #[serde(default)]
    pub(crate) compact_at_tokens: Option<i64>,
    /// False before the first request: the figures price what it would send.
    #[serde(default = "sent_by_default")]
    pub(crate) sent: bool,
    #[serde(default)]
    pub(crate) model: Option<String>,
    #[serde(default)]
    pub(crate) categories: Vec<ContextCategory>,
}

fn sent_by_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextCategory {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) tokens: i64,
    #[serde(default)]
    pub(crate) items: i64,
}

/// Ask the uac server for `thread_id`'s context breakdown.
pub(crate) async fn fetch_context_usage(
    request_handle: AppServerRequestHandle,
    thread_id: ThreadId,
) -> Result<ContextUsage, String> {
    let AppServerRequestHandle::Remote(handle) = request_handle else {
        return Err("/context needs the unieai-agent-core engine".to_string());
    };
    let response = handle
        .request_json_rpc(JSONRPCRequest {
            id: RequestId::String(format!("tui-context-{}", Uuid::new_v4())),
            method: CONTEXT_READ_METHOD.to_string(),
            params: Some(json!({ "threadId": thread_id.to_string() })),
            trace: None,
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.message)?;
    serde_json::from_value(response).map_err(|err| format!("unexpected answer: {err}"))
}

/// One color per kind of content, so the bar and the rows agree.
fn category_style(id: &str) -> Style {
    match id {
        "toolsBuiltin" | "toolsMcp" | "toolsClient" => Style::new().magenta(),
        "messages" | "summary" => Style::new().green(),
        "toolResults" => Style::new().green().dim(),
        "notices" => Style::new().dim(),
        _ => Style::new().cyan(),
    }
}

fn percent_of(tokens: i64, window: Option<i64>) -> String {
    match window {
        Some(window) if window > 0 => format!("{:.1}%", tokens as f64 * 100.0 / window as f64),
        _ => String::new(),
    }
}

/// The used part of the window as colored cells, the rest as free cells, with
/// the compaction point marked.
fn usage_bar(usage: &ContextUsage, window: i64) -> Line<'static> {
    let cells_for =
        |tokens: i64| ((tokens.max(0) as f64 / window as f64) * BAR_WIDTH as f64).round() as usize;
    let mut cells: Vec<(char, Style)> = Vec::with_capacity(BAR_WIDTH);
    for category in &usage.categories {
        let wanted = cells_for(category.tokens);
        // Anything present gets at least one cell, as long as there is room.
        let count = if category.tokens > 0 {
            wanted.max(1)
        } else {
            0
        };
        for _ in 0..count {
            if cells.len() < BAR_WIDTH {
                cells.push(('█', category_style(&category.id)));
            }
        }
    }
    while cells.len() < BAR_WIDTH {
        cells.push(('░', Style::new().dim()));
    }
    if let Some(at) = usage.compact_at_tokens {
        let index = cells_for(at).min(BAR_WIDTH - 1);
        cells[index] = ('│', Style::new().red());
    }
    let mut spans = vec![Span::raw("  ")];
    spans.extend(
        cells
            .into_iter()
            .map(|(glyph, style)| Span::styled(glyph.to_string(), style)),
    );
    Line::from(spans)
}

fn row(marker: Span<'static>, label: String, tokens: i64, window: Option<i64>) -> Line<'static> {
    let mut spans = vec![
        Span::raw("  "),
        marker,
        Span::raw(" "),
        Span::raw(format!("{label:<LABEL_WIDTH$}")),
        Span::raw(format!("{:>8}", format_tokens_compact(tokens))),
    ];
    let share = percent_of(tokens, window);
    if !share.is_empty() {
        spans.push(Span::raw(format!("{share:>8}")).dim());
    }
    Line::from(spans)
}

/// What `/context` prints into history.
pub(crate) fn context_usage_lines(usage: &ContextUsage) -> Vec<Line<'static>> {
    let window = usage.context_window.filter(|window| *window > 0);
    let mut header = vec![
        "/context".magenta(),
        Span::raw("  "),
        Span::raw(format_tokens_compact(usage.total_tokens)).bold(),
    ];
    match window {
        Some(window) => {
            header.push(Span::raw(format!(
                " / {} tokens ({})",
                format_tokens_compact(window),
                percent_of(usage.total_tokens, Some(window))
            )));
        }
        None => header.push(Span::raw(" tokens")),
    }
    if let Some(model) = usage.model.as_deref().filter(|model| !model.is_empty()) {
        header.push(format!(" · {model}").dim());
    }
    let mut lines = vec![Line::from(header)];
    if let Some(window) = window {
        lines.push(usage_bar(usage, window));
    }
    for category in &usage.categories {
        if category.tokens == 0 && category.items == 0 {
            continue;
        }
        let label = if category.id.starts_with("tools") && category.items > 0 {
            format!("{} ({})", category.label, category.items)
        } else {
            category.label.clone()
        };
        lines.push(row(
            Span::styled("█", category_style(&category.id)),
            label,
            category.tokens,
            window,
        ));
    }
    if let Some(free) = usage.free_tokens {
        lines.push(row("░".dim(), "Free".to_string(), free, window));
    }
    if let Some(at) = usage.compact_at_tokens {
        let share = percent_of(at, window);
        let share = if share.is_empty() {
            String::new()
        } else {
            format!(" ({share} of the window)")
        };
        lines.push(Line::from(vec![
            Span::raw("  "),
            "│".red(),
            Span::raw(format!(
                " Auto-compacts at {}{share}",
                format_tokens_compact(at)
            )),
        ]));
    }
    let note = if !usage.sent {
        "Nothing sent yet: what the first request would carry, estimated at 4 characters a token."
    } else if usage.calibrated {
        "Parts are estimates (4 characters a token), scaled to the last request's reported size."
    } else {
        "Estimates (4 characters a token); no request has reported its size yet."
    };
    lines.push(Line::from(vec![Span::raw("  "), note.dim()]));
    lines
}

#[cfg(test)]
#[path = "unieai_context_tests.rs"]
mod unieai_context_tests;
