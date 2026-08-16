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
        elapsed: None,
        tokens: None,
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
            ..agent("5a6b0c0d0e0f", "main")
        },
        AgentRow {
            activity: Some("Locating DebugCommand struct in cli/src/main.rs".to_string()),
            elapsed: Some("5m 49s".to_string()),
            tokens: Some(95_400),
            is_running: false,
            ..agent("5a6b9a8b7c6d", "Plan")
        },
        AgentRow {
            activity: Some("Listing core/tests/suite and exec/src/cli.rs".to_string()),
            elapsed: Some("4m 36s".to_string()),
            tokens: Some(82_800),
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
