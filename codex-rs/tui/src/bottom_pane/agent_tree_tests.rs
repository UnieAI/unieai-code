use super::*;
use codex_protocol::ThreadId;
use pretty_assertions::assert_eq;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

fn agent(tail: &str, label: &str) -> AgentRow {
    AgentRow {
        target: TreeTarget::Thread(thread_id(tail)),
        label: label.to_string(),
        activity: None,
        is_running: true,
        is_active: false,
        is_failed: false,
        elapsed: None,
        tokens: None,
        model: None,
        context_left_percent: None,
    }
}

fn rendered(tree: &AgentTree) -> Vec<String> {
    tree.lines(120)
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect()
}

#[test]
fn an_empty_tree_renders_nothing() {
    let tree = AgentTree::default();

    assert!(tree.is_empty());
    assert_eq!(tree.desired_height(80), 0);
}

#[test]
fn focus_is_refused_when_there_is_nothing_to_select() {
    let mut tree = AgentTree::default();
    tree.set_todos(vec![TodoRow {
        text: "write the thing".to_string(),
        status: TodoStatus::InProgress,
    }]);

    // Todos are not navigable, so an arrow key here must still reach history
    // recall rather than moving a cursor that has nowhere to go.
    assert!(!tree.focus_tree());
    assert_eq!(tree.focus(), PaneFocus::Composer);
}

#[test]
fn focus_moves_into_the_tree_when_there_are_agents() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![agent("5a6b0c0d0e0f", "plan")]);

    assert!(tree.focus_tree());
    assert_eq!(tree.focus(), PaneFocus::AgentTree);
    assert_eq!(
        tree.selected_target(),
        Some(&TreeTarget::Thread(thread_id("5a6b0c0d0e0f")))
    );

    tree.focus_composer();
    assert_eq!(tree.focus(), PaneFocus::Composer);
}

#[test]
fn selection_moves_and_stops_at_the_ends() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![
        agent("5a6b0c0d0e0f", "first"),
        agent("5a6b9a8b7c6d", "second"),
    ]);
    tree.focus_tree();

    // Clamped rather than wrapping: wrapping past the last row would move the
    // cursor somewhere the user did not look.
    tree.select_previous();
    assert_eq!(
        tree.selected_target(),
        Some(&TreeTarget::Thread(thread_id("5a6b0c0d0e0f")))
    );
    tree.select_next();
    tree.select_next();
    assert_eq!(
        tree.selected_target(),
        Some(&TreeTarget::Thread(thread_id("5a6b9a8b7c6d")))
    );
}

#[test]
fn a_refresh_keeps_the_cursor_on_the_same_agent() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![
        agent("5a6b0c0d0e0f", "first"),
        agent("5a6b9a8b7c6d", "second"),
    ]);
    tree.focus_tree();
    tree.select_next();

    // A new agent appearing at the top must not drag the selection with it —
    // the panel refreshes on a timer, under the user's fingers.
    tree.set_agents(vec![
        agent("5a6b4455667f", "newcomer"),
        agent("5a6b0c0d0e0f", "first"),
        agent("5a6b9a8b7c6d", "second"),
    ]);

    assert_eq!(
        tree.selected_target(),
        Some(&TreeTarget::Thread(thread_id("5a6b9a8b7c6d")))
    );
}

#[test]
fn focus_returns_to_the_composer_when_the_last_agent_leaves() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![agent("5a6b0c0d0e0f", "only")]);
    tree.focus_tree();

    tree.set_agents(Vec::new());

    // Focus cannot rest on nothing, and leaving it in the tree would swallow
    // every subsequent keystroke.
    assert_eq!(tree.focus(), PaneFocus::Composer);
}

#[test]
fn rows_show_activity_elapsed_and_tokens() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![AgentRow {
        activity: Some("Locating DebugCommand struct".to_string()),
        elapsed: Some("5m 49s".to_string()),
        tokens: Some(95_400),
        context_left_percent: None,
        ..agent("5a6b0c0d0e0f", "Plan")
    }]);

    let lines = rendered(&tree);

    assert!(lines[0].contains("Plan"), "{lines:?}");
    assert!(
        lines[0].contains("Locating DebugCommand struct"),
        "{lines:?}"
    );
    assert!(lines[0].contains("5m 49s"), "{lines:?}");
    assert!(lines[0].contains("↓ 95.4k tokens"), "{lines:?}");
}

#[test]
fn the_focused_row_is_marked_and_the_hint_appears() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![
        agent("5a6b0c0d0e0f", "first"),
        agent("5a6b9a8b7c6d", "second"),
    ]);

    let unfocused = rendered(&tree);
    assert!(!unfocused.iter().any(|line| line.contains("↑↓ select")));

    tree.focus_tree();
    let focused = rendered(&tree);

    assert!(focused[0].starts_with("› "), "{focused:?}");
    assert!(focused[1].starts_with("  "), "{focused:?}");
    // The hint only appears while the tree owns the arrow keys, so it doubles
    // as the signal that history recall is temporarily unavailable.
    assert!(
        focused
            .iter()
            .any(|line| line.contains("esc back to input")),
        "{focused:?}"
    );
}

#[test]
fn todos_and_agents_are_separated_when_both_are_present() {
    let mut tree = AgentTree::default();
    tree.set_todos(vec![TodoRow {
        text: "ship it".to_string(),
        status: TodoStatus::Completed,
    }]);
    tree.set_agents(vec![agent("5a6b0c0d0e0f", "worker")]);

    let lines = rendered(&tree);

    assert!(lines[0].contains("ship it"), "{lines:?}");
    assert_eq!(lines[1], "", "the two halves need a visual break");
    assert!(lines[2].contains("worker"), "{lines:?}");
}

#[test]
fn token_counts_stay_short() {
    assert_eq!(format_tokens(950), "↓ 950 tokens");
    assert_eq!(format_tokens(95_400), "↓ 95.4k tokens");
    assert_eq!(format_tokens(2_500_000), "↓ 2.5M tokens");
}

/// Renders the shape the panel is meant to produce, as a readable block.
///
/// Kept as a test rather than a comment so the format cannot drift silently:
/// this is the layout the feature was specified against.
#[test]
fn the_panel_renders_the_specified_layout() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![
        AgentRow {
            is_running: false,
            is_active: true,
            is_failed: false,
            ..agent("5a6b0c0d0e0f", "main")
        },
        AgentRow {
            activity: Some("Locating DebugCommand struct in cli/src/main.rs".to_string()),
            elapsed: Some("5m 49s".to_string()),
            tokens: Some(95_400),
            context_left_percent: None,
            is_running: false,
            ..agent("5a6b9a8b7c6d", "Plan")
        },
        AgentRow {
            activity: Some("Listing core/tests/suite and exec/src/cli.rs".to_string()),
            elapsed: Some("4m 36s".to_string()),
            tokens: Some(82_800),
            context_left_percent: None,
            is_running: false,
            ..agent("5a6b4455667f", "Plan")
        },
    ]);

    let lines = rendered(&tree);
    println!("\n{}\n", lines.join("\n"));

    assert_eq!(lines.len(), 3);
    assert!(lines[0].contains("main"), "{lines:?}");
    assert!(
        lines[1].contains("Plan")
            && lines[1].contains("Locating DebugCommand struct in cli/src/main.rs")
            && lines[1].contains("5m 49s")
            && lines[1].contains("↓ 95.4k tokens"),
        "{lines:?}"
    );
    assert!(
        lines[2].contains("4m 36s") && lines[2].contains("↓ 82.8k tokens"),
        "{lines:?}"
    );
}

#[test]
fn the_row_shows_time_tokens_and_how_much_context_is_left() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![AgentRow {
        target: TreeTarget::Thread(ThreadId::new()),
        label: "main".to_string(),
        activity: None,
        is_running: true,
        is_active: true,
        is_failed: false,
        elapsed: Some("1m02s".to_string()),
        tokens: Some(35_400),
        model: None,
        context_left_percent: Some(87),
    }]);
    let rendered = tree
        .lines(/*width*/ 120)
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        rendered.contains("1m02s · ↓ 35.4k tokens · 87% context left"),
        "{rendered}"
    );
}

#[test]
fn a_finished_plan_leaves_the_panel_at_once_but_an_unfinished_one_stays() {
    let done = |text: &str| TodoRow {
        text: text.to_string(),
        status: TodoStatus::Completed,
    };
    let mut tree = AgentTree::default();
    tree.set_todos(vec![done("read"), done("write")]);
    assert!(tree.retire_finished_todos());
    assert!(tree.is_empty(), "the transcript card is the record now");
    assert!(!tree.retire_finished_todos(), "nothing left to retire");

    tree.set_todos(vec![
        done("read"),
        TodoRow {
            text: "write".to_string(),
            status: TodoStatus::Pending,
        },
    ]);
    assert!(!tree.retire_finished_todos());
    assert!(!tree.is_empty(), "what is left is worth keeping on screen");
}

fn exec_session(tail: &str, process_id: &str, command: &str) -> AgentRow {
    AgentRow {
        target: TreeTarget::ExecSession {
            thread: thread_id(tail),
            process_id: process_id.to_string(),
        },
        label: command.to_string(),
        activity: None,
        is_running: true,
        is_active: false,
        is_failed: false,
        elapsed: Some("12s".to_string()),
        tokens: None,
        model: None,
        context_left_percent: None,
    }
}

#[test]
fn the_tree_shows_each_agents_model_and_the_commands_left_running() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![
        AgentRow {
            is_running: false,
            is_active: true,
            is_failed: false,
            model: Some("Qwen3.6-35B-A3B".to_string()),
            ..agent("5a6b0c0d0e0f", "main")
        },
        exec_session("5a6b0c0d0e0f", "1000", "sleep 120"),
        AgentRow {
            activity: Some("Running cargo test".to_string()),
            elapsed: Some("1m 05s".to_string()),
            tokens: Some(12_300),
            model: Some("Qwen3.6-35B-A3B".to_string()),
            ..agent("5a6b9a8b7c6d", "count_lines")
        },
        exec_session("5a6b9a8b7c6d", "1001", "npm run dev"),
    ]);
    tree.focus_tree();
    tree.select_next();

    insta::assert_snapshot!(rendered(&tree).join("\n"));
    assert_eq!(
        tree.selected_target(),
        Some(&TreeTarget::ExecSession {
            thread: thread_id("5a6b0c0d0e0f"),
            process_id: "1000".to_string(),
        })
    );
    assert_eq!(
        tree.selected_row().map(|row| row.label.as_str()),
        Some("sleep 120")
    );
}

#[test]
fn a_running_agent_is_shown() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![AgentRow {
        activity: Some("Running date".to_string()),
        elapsed: Some("4s".to_string()),
        tokens: Some(1_200),
        model: Some("Qwen3.6-35B-A3B".to_string()),
        ..agent("5a6b9a8b7c6d", "date_check")
    }]);

    insta::assert_snapshot!(rendered(&tree).join("\n"));
}

#[test]
fn a_failed_agent_is_marked_until_it_is_seen() {
    let mut tree = AgentTree::default();
    tree.set_agents(vec![AgentRow {
        activity: Some("failed".to_string()),
        is_running: false,
        is_failed: true,
        elapsed: Some("12s".to_string()),
        tokens: Some(3_400),
        ..agent("5a6b9a8b7c6d", "flaky_worker")
    }]);

    insta::assert_snapshot!(rendered(&tree).join("\n"));
}

#[test]
fn finished_work_leaves_a_hint_pointing_at_tasks() {
    let mut tree = AgentTree::default();
    tree.set_todos(vec![TodoRow {
        text: "check the date".to_string(),
        status: TodoStatus::InProgress,
    }]);
    tree.set_agents(vec![AgentRow {
        elapsed: Some("30s".to_string()),
        ..agent("5a6b9a8b7c6d", "still_working")
    }]);
    assert!(tree.set_hidden_done(2));
    assert!(!tree.set_hidden_done(2), "no change, no redraw");

    insta::assert_snapshot!(rendered(&tree).join("\n"));
}

#[test]
fn the_hint_alone_keeps_the_panel_to_one_line() {
    let mut tree = AgentTree::default();
    tree.set_hidden_done(1);

    assert!(!tree.is_empty());
    assert_eq!(rendered(&tree), vec!["  1 done · /tasks".to_string()]);
    // The hint is not a row: there is nothing to move a cursor to.
    assert!(!tree.focus_tree());
}

#[test]
fn the_panel_collapses_to_the_todos_then_disappears() {
    let mut tree = AgentTree::default();
    tree.set_todos(vec![TodoRow {
        text: "write it".to_string(),
        status: TodoStatus::Pending,
    }]);
    tree.set_agents(vec![agent("5a6b9a8b7c6d", "worker")]);
    tree.set_hidden_done(1);

    // The worker finished and the user opened /tasks.
    tree.set_agents(Vec::new());
    tree.set_hidden_done(0);
    assert_eq!(rendered(&tree), vec!["  ☐ write it".to_string()]);

    tree.set_todos(Vec::new());
    assert!(tree.is_empty());
    assert_eq!(tree.desired_height(80), 0);
}
