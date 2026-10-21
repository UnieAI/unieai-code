// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::app_event_sender::AppEventSender;
use crate::bottom_pane::BottomPaneView;
use crate::bottom_pane::ListSelectionView;
use crate::render::renderable::Renderable;
use codex_app_server_protocol::CommandExecutionStatus;
use codex_app_server_protocol::ItemCompletedNotification;
use codex_app_server_protocol::ItemStartedNotification;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use pretty_assertions::assert_eq;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use tokio::sync::mpsc::unbounded_channel;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

fn command_item(
    process_id: Option<&str>,
    source: CommandExecutionSource,
    status: CommandExecutionStatus,
) -> ThreadItem {
    serde_json::from_value(serde_json::json!({
        "type": "commandExecution",
        "id": "exec-session-1000",
        "command": "sleep 120",
        "cwd": "/repo",
        "processId": process_id,
        "source": source,
        "status": status,
        "commandActions": [{ "type": "unknown", "command": "sleep 120" }],
        "aggregatedOutput": null,
        "exitCode": null,
        "durationMs": null,
    }))
    .expect("a commandExecution item")
}

fn started(thread: ThreadId, item: ThreadItem) -> ServerNotification {
    ServerNotification::ItemStarted(ItemStartedNotification {
        thread_id: thread.to_string(),
        turn_id: "turn-1".to_string(),
        item,
        started_at_ms: 0,
    })
}

fn completed(thread: ThreadId, item: ThreadItem) -> ServerNotification {
    ServerNotification::ItemCompleted(ItemCompletedNotification {
        thread_id: thread.to_string(),
        turn_id: "turn-1".to_string(),
        item,
        completed_at_ms: 0,
    })
}

#[test]
fn a_command_left_running_is_tracked_until_it_completes() {
    let thread = thread_id("5a6b0c0d0e0f");
    let mut monitor = TaskMonitor::default();
    let running = command_item(
        Some("1000"),
        CommandExecutionSource::UnifiedExecStartup,
        CommandExecutionStatus::InProgress,
    );
    assert!(monitor.observe(thread, &started(thread, running.clone())));
    assert!(
        !monitor.observe(thread, &started(thread, running)),
        "seen once"
    );
    assert_eq!(
        monitor
            .exec_sessions()
            .iter()
            .map(|entry| (
                entry.thread_id,
                entry.process_id.as_str(),
                entry.command.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![(thread, "1000", "sleep 120")]
    );

    let done = command_item(
        Some("1000"),
        CommandExecutionSource::UnifiedExecStartup,
        CommandExecutionStatus::Completed,
    );
    assert!(monitor.observe(thread, &completed(thread, done)));
    assert!(monitor.exec_sessions().is_empty());
}

#[test]
fn ordinary_commands_are_not_background_tasks() {
    let thread = thread_id("5a6b0c0d0e0f");
    let mut monitor = TaskMonitor::default();
    for item in [
        // No process: a command that ran to completion within its call.
        command_item(
            None,
            CommandExecutionSource::UnifiedExecStartup,
            CommandExecutionStatus::InProgress,
        ),
        // The user's own shell command.
        command_item(
            Some("7"),
            CommandExecutionSource::UserShell,
            CommandExecutionStatus::InProgress,
        ),
    ] {
        assert!(!monitor.observe(thread, &started(thread, item)));
    }
    assert!(monitor.exec_sessions().is_empty());
}

#[test]
fn a_command_only_finishes_in_its_own_thread() {
    let mut monitor = TaskMonitor::default();
    let first = thread_id("5a6b0c0d0e0f");
    let second = thread_id("5a6b9a8b7c6d");
    let running = command_item(
        Some("1000"),
        CommandExecutionSource::UnifiedExecStartup,
        CommandExecutionStatus::InProgress,
    );
    monitor.observe(first, &started(first, running));
    assert!(!monitor.finish_exec_session(second, "1000", None, false, true));
    assert!(monitor.exec_session(first, "1000").is_some());
    assert!(monitor.finish_exec_session(first, "1000", None, false, true));
}

#[test]
fn a_command_label_drops_the_shell_wrapper() {
    assert_eq!(command_label("bash -lc 'sleep 120'"), "sleep 120");
    assert_eq!(command_label("npm run dev"), "npm run dev");
}

#[test]
fn exec_output_says_what_ran_and_how_it_ended() {
    let lines = exec_output_lines(&ExecOutput {
        command: Some("sleep 120".to_string()),
        cwd: Some("/repo".to_string()),
        running: false,
        exit_code: Some(143),
        output: "tick 1\ntick 2\n".to_string(),
    });
    assert_eq!(
        lines,
        vec![
            "sleep 120 · exited 143 · /repo".to_string(),
            String::new(),
            "tick 1".to_string(),
            "tick 2".to_string(),
        ]
    );
}

fn render(view: &ListSelectionView, width: u16) -> String {
    let height = view.desired_height(width);
    let area = Rect::new(/*x*/ 0, /*y*/ 0, width, height);
    let mut buf = Buffer::empty(area);
    view.render(area, &mut buf);
    (0..area.height)
        .map(|y| {
            (0..area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn stopping_a_command_asks_first() {
    let keymap = crate::keymap::RuntimeKeymap::defaults();
    let target = TreeTarget::ExecSession {
        thread: thread_id("5a6b0c0d0e0f"),
        process_id: "1000".to_string(),
    };
    let (tx, mut rx) = unbounded_channel();
    let mut view = ListSelectionView::new(
        stop_confirmation_params(
            target.clone(),
            "sleep 120".to_string(),
            /*reopen_tasks*/ true,
        ),
        AppEventSender::new(tx),
        keymap.list.clone(),
    );
    insta::assert_snapshot!(render(&view, /*width*/ 72));

    // "No" is preselected: Enter right away keeps the command and goes back.
    view.handle_key_event(KeyEvent::from(KeyCode::Enter));
    assert!(matches!(rx.try_recv(), Ok(AppEvent::OpenTasks)));

    let (tx, mut rx) = unbounded_channel();
    let mut view = ListSelectionView::new(
        stop_confirmation_params(
            target.clone(),
            "sleep 120".to_string(),
            /*reopen_tasks*/ false,
        ),
        AppEventSender::new(tx),
        keymap.list,
    );
    view.handle_key_event(KeyEvent::from(KeyCode::Up));
    view.handle_key_event(KeyEvent::from(KeyCode::Enter));
    match rx.try_recv() {
        Ok(AppEvent::StopTask {
            target: stopped,
            reopen_tasks,
        }) => {
            assert_eq!(stopped, target);
            assert!(!reopen_tasks);
        }
        other => panic!("expected a stop, got {other:?}"),
    }
}

#[test]
fn stopping_an_agent_asks_first() {
    let keymap = crate::keymap::RuntimeKeymap::defaults();
    let (tx, _rx) = unbounded_channel();
    let view = ListSelectionView::new(
        stop_confirmation_params(
            TreeTarget::Thread(thread_id("5a6b9a8b7c6d")),
            "count_lines".to_string(),
            /*reopen_tasks*/ false,
        ),
        AppEventSender::new(tx),
        keymap.list,
    );
    insta::assert_snapshot!(render(&view, /*width*/ 72));
}

#[test]
fn an_exited_command_is_kept_as_finished_and_counted_until_seen() {
    let thread = thread_id("5a6b0c0d0e0f");
    let mut monitor = TaskMonitor::default();
    monitor.observe(
        thread,
        &started(
            thread,
            command_item(
                Some("1000"),
                CommandExecutionSource::UnifiedExecStartup,
                CommandExecutionStatus::InProgress,
            ),
        ),
    );
    assert_eq!(monitor.hidden_done(), 0, "still running");

    monitor.observe(
        thread,
        &completed(
            thread,
            command_item(
                Some("1000"),
                CommandExecutionSource::UnifiedExecStartup,
                CommandExecutionStatus::Failed,
            ),
        ),
    );
    assert!(monitor.exec_sessions().is_empty());
    let finished = monitor
        .finished_command(thread, "1000")
        .expect("kept for /tasks");
    assert!(finished.failed);
    assert_eq!(monitor.hidden_done(), 1);

    assert!(monitor.acknowledge_all());
    assert_eq!(monitor.hidden_done(), 0);
    assert!(!monitor.acknowledge_all(), "nothing new to see");
}

#[test]
fn a_finished_agent_is_hidden_after_its_grace_and_a_failure_is_news() {
    let thread = thread_id("5a6b9a8b7c6d");
    let mut monitor = TaskMonitor::default();

    assert!(monitor.agent_finished(thread, Duration::from_secs(6), /*failed*/ false));
    assert!(
        !monitor.agent_finished(thread, Duration::from_secs(6), /*failed*/ false),
        "idle and closed after the turn completed report the same ending"
    );
    assert_eq!(monitor.hidden_done(), 0, "still inside its grace period");
    monitor.age_finished_agents(FINISHED_GRACE);
    assert_eq!(monitor.hidden_done(), 1);

    // Looking at the thread is seeing it.
    assert!(monitor.acknowledge_agent(thread));
    assert_eq!(monitor.hidden_done(), 0);

    // A failure reported after the clean ending is news again.
    assert!(monitor.agent_finished(thread, Duration::from_secs(6), /*failed*/ true));
    let finished = monitor.finished_agent(thread).copied().expect("recorded");
    assert!(finished.failed && !finished.acknowledged);
    assert_eq!(
        monitor.hidden_done(),
        0,
        "a failure stays on the tree, so it is not counted as hidden"
    );

    // A new turn: working again.
    assert!(monitor.agent_started(thread));
    assert!(monitor.finished_agent(thread).is_none());
}
