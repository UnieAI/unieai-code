// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use codex_protocol::ThreadId;
use crossterm::event::KeyCode;
use crossterm::event::KeyModifiers;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::mpsc::unbounded_channel;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

fn subagent(tail: &str, label: &str, status: TaskStatus) -> TaskRow {
    TaskRow {
        target: TreeTarget::Thread(thread_id(tail)),
        label: label.to_string(),
        status,
        elapsed: None,
        tokens: None,
        model: Some("Qwen3.6-35B-A3B".to_string()),
        detail: None,
    }
}

fn command(tail: &str, process_id: &str, line: &str) -> TaskRow {
    TaskRow {
        target: TreeTarget::ExecSession {
            thread: thread_id(tail),
            process_id: process_id.to_string(),
        },
        label: line.to_string(),
        status: TaskStatus::Running,
        elapsed: Some("12s".to_string()),
        tokens: None,
        model: None,
        detail: Some("started by main".to_string()),
    }
}

fn sample_rows() -> Vec<TaskRow> {
    vec![
        // Out of order on purpose: commands go after the subagents.
        command("5a6b0c0d0e0f", "1000", "sleep 120"),
        TaskRow {
            elapsed: Some("1m 05s".to_string()),
            tokens: Some(12_300),
            detail: Some("Running wc -l calc.py".to_string()),
            ..subagent("5a6b9a8b7c6d", "count_lines", TaskStatus::Running)
        },
        TaskRow {
            tokens: Some(4_100),
            detail: Some("Answered".to_string()),
            ..subagent("5a6b4455667f", "planner", TaskStatus::Done)
        },
    ]
}

fn tasks_view(rows: Vec<TaskRow>) -> (TasksView, UnboundedReceiver<AppEvent>) {
    let (tx, rx) = unbounded_channel();
    let keymap = crate::keymap::RuntimeKeymap::defaults();
    (
        TasksView::new(rows, AppEventSender::new(tx), keymap.list, keymap.agents),
        rx,
    )
}

fn press(view: &mut TasksView, code: KeyCode) {
    view.handle_key_event(KeyEvent::new(code, KeyModifiers::NONE));
}

fn rendered(view: &TasksView, width: u16) -> String {
    let area = Rect::new(
        /*x*/ 0,
        /*y*/ 0,
        width,
        view.desired_height(width),
    );
    let mut buffer = Buffer::empty(area);
    view.render(area, &mut buffer);
    buffer
        .content
        .chunks(usize::from(buffer.area.width))
        .map(|row| {
            row.iter()
                .map(ratatui::buffer::Cell::symbol)
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn tasks_lists_subagents_then_commands_with_status_time_tokens_model_and_last_action() {
    let (view, _rx) = tasks_view(sample_rows());
    insta::assert_snapshot!(rendered(&view, /*width*/ 110));
}

#[test]
fn tasks_with_nothing_running_says_so() {
    let (view, _rx) = tasks_view(Vec::new());
    insta::assert_snapshot!(rendered(&view, /*width*/ 80));
}

#[test]
fn stop_asks_first_and_only_for_something_running() {
    let (mut view, mut rx) = tasks_view(sample_rows());
    // The finished planner (second subagent) cannot be stopped.
    press(&mut view, KeyCode::Down);
    press(&mut view, KeyCode::Char('x'));
    assert!(rx.try_recv().is_err());
    assert!(!view.is_complete());

    // The background command (last row) can.
    press(&mut view, KeyCode::Down);
    press(&mut view, KeyCode::Char('x'));
    match rx.try_recv() {
        Ok(AppEvent::ConfirmStopTask {
            target,
            label,
            reopen_tasks,
        }) => {
            assert_eq!(
                target,
                TreeTarget::ExecSession {
                    thread: thread_id("5a6b0c0d0e0f"),
                    process_id: "1000".to_string(),
                }
            );
            assert_eq!(label, "sleep 120");
            assert!(reopen_tasks);
        }
        other => panic!("expected a stop confirmation, got {other:?}"),
    }
    assert!(view.is_complete());
}

#[test]
fn open_switches_to_the_selected_task() {
    let (mut view, mut rx) = tasks_view(sample_rows());
    press(&mut view, KeyCode::Char('o'));
    match rx.try_recv() {
        Ok(AppEvent::OpenTask(target)) => {
            assert_eq!(target, TreeTarget::Thread(thread_id("5a6b9a8b7c6d")));
        }
        other => panic!("expected an open, got {other:?}"),
    }
    assert!(view.is_complete());

    let (mut view, mut rx) = tasks_view(sample_rows());
    press(&mut view, KeyCode::End);
    press(&mut view, KeyCode::Enter);
    assert!(matches!(
        rx.try_recv(),
        Ok(AppEvent::OpenTask(TreeTarget::ExecSession { .. }))
    ));
}

#[test]
fn escape_closes_without_acting() {
    let (mut view, mut rx) = tasks_view(sample_rows());
    press(&mut view, KeyCode::Esc);
    assert!(view.is_complete());
    assert!(rx.try_recv().is_err());
}
