// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

fn text(lines: &[Line<'static>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The uac server's answer after one turn (measured end to end).
fn answer() -> serde_json::Value {
    json!({
        "totalTokens": 12698,
        "estimatedTokens": 10502,
        "calibrated": true,
        "contextWindow": 131072,
        "freeTokens": 118374,
        "compactAtTokens": 65536,
        "compactRatio": 0.75,
        "sent": true,
        "model": "fake-model",
        "categories": [
            { "id": "system", "label": "System prompt", "tokens": 3377, "items": 1 },
            { "id": "toolsBuiltin", "label": "Tools: built-in", "tokens": 7412, "items": 28 },
            { "id": "toolsMcp", "label": "Tools: MCP", "tokens": 0, "items": 0 },
            { "id": "toolsClient", "label": "Tools: client", "tokens": 0, "items": 0 },
            { "id": "instructions", "label": "Instructions (AGENTS.md)", "tokens": 882, "items": 1 },
            { "id": "skills", "label": "Skills", "tokens": 238, "items": 1 },
            { "id": "messages", "label": "Messages", "tokens": 65, "items": 3 },
            { "id": "toolResults", "label": "Tool results", "tokens": 492, "items": 1 },
            { "id": "summary", "label": "Compaction summary", "tokens": 0, "items": 0 },
            { "id": "notices", "label": "Runtime context & notices", "tokens": 232, "items": 2 }
        ]
    })
}

#[test]
fn context_usage_after_a_turn() {
    let usage: ContextUsage = serde_json::from_value(answer()).expect("usage");
    insta::assert_snapshot!(text(&context_usage_lines(&usage)));
}

#[test]
fn context_usage_before_the_first_request_without_a_window() {
    let usage: ContextUsage = serde_json::from_value(json!({
        "totalTokens": 8925,
        "calibrated": false,
        "contextWindow": null,
        "freeTokens": null,
        "compactAtTokens": null,
        "sent": false,
        "categories": [
            { "id": "system", "label": "System prompt", "tokens": 2795, "items": 1 },
            { "id": "toolsBuiltin", "label": "Tools: built-in", "tokens": 6130, "items": 28 },
            { "id": "toolsMcp", "label": "Tools: MCP", "tokens": 0, "items": 0 }
        ]
    }))
    .expect("usage");
    insta::assert_snapshot!(text(&context_usage_lines(&usage)));
}

#[test]
fn the_bar_fills_by_share_and_marks_the_compaction_point() {
    let usage: ContextUsage = serde_json::from_value(answer()).expect("usage");
    let bar = text(&[usage_bar(&usage, 131_072)]);
    let cells: Vec<char> = bar.trim_start().chars().collect();
    assert_eq!(cells.len(), BAR_WIDTH);
    assert_eq!(cells[20], '│', "65536 of 131072 is the middle cell");
    let used = cells.iter().filter(|cell| **cell == '█').count();
    // System 1, tools 2, and one cell each for the small parts.
    assert_eq!(used, 8);
}
