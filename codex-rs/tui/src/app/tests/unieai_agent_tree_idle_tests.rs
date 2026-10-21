// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::app::unieai_tasks::FINISHED_GRACE;
use crate::bottom_pane::TaskRow;
use crate::bottom_pane::TaskStatus;
use crate::bottom_pane::TreeTarget;
use codex_app_server_protocol::ThreadStatus;
use codex_app_server_protocol::ThreadStatusChangedNotification;
use pretty_assertions::assert_eq;

async fn app_with_running_agent(thread_id: ThreadId) -> Result<Box<App>> {
    let mut app = Box::pin(make_test_app()).await;
    app.primary_thread_id = Some(thread_id);
    app.thread_event_channels
        .insert(thread_id, ThreadEventChannel::new(/*capacity*/ 8));
    app.agent_navigation
        .upsert(thread_id, None, None, /*is_closed*/ false);
    Box::pin(
        app.enqueue_thread_notification(thread_id, turn_started_notification(thread_id, "turn-1")),
    )
    .await?;
    app.agent_activity
        .insert(thread_id, "$ echo one".to_string());
    assert!(
        app.agent_navigation
            .get(&thread_id)
            .is_some_and(|entry| entry.is_running)
    );
    Ok(app)
}

#[tokio::test]
async fn turn_completion_returns_the_agent_row_to_idle() -> Result<()> {
    let thread_id = ThreadId::new();
    let mut app = app_with_running_agent(thread_id).await?;

    Box::pin(app.enqueue_thread_notification(
        thread_id,
        turn_completed_notification(thread_id, "turn-1", TurnStatus::Completed),
    ))
    .await?;

    assert!(
        app.agent_navigation
            .get(&thread_id)
            .is_some_and(|entry| !entry.is_running)
    );
    assert_eq!(app.agent_activity.get(&thread_id), None);
    Ok(())
}

#[tokio::test]
async fn idle_status_stops_the_agent_row_without_turn_completion() -> Result<()> {
    let thread_id = ThreadId::new();
    let mut app = app_with_running_agent(thread_id).await?;

    Box::pin(app.enqueue_thread_notification(
        thread_id,
        ServerNotification::ThreadStatusChanged(ThreadStatusChangedNotification {
            thread_id: thread_id.to_string(),
            status: ThreadStatus::Idle,
        }),
    ))
    .await?;

    assert!(
        app.agent_navigation
            .get(&thread_id)
            .is_some_and(|entry| !entry.is_running)
    );
    assert_eq!(app.agent_activity.get(&thread_id), None);
    Ok(())
}

/// A session with a main thread on screen and one subagent, `date_check`,
/// mid-turn.
async fn app_with_running_subagent(main: ThreadId, child: ThreadId) -> Result<Box<App>> {
    let mut app = Box::pin(make_test_app()).await;
    app.primary_thread_id = Some(main);
    app.active_thread_id = Some(main);
    for thread_id in [main, child] {
        app.thread_event_channels
            .insert(thread_id, ThreadEventChannel::new(/*capacity*/ 8));
    }
    app.agent_navigation
        .upsert(main, None, None, /*is_closed*/ false);
    app.agent_navigation.upsert(
        child,
        Some("date_check".to_string()),
        None,
        /*is_closed*/ false,
    );
    Box::pin(app.enqueue_thread_notification(child, turn_started_notification(child, "turn-1")))
        .await?;
    Ok(app)
}

fn tree(app: &App) -> Vec<String> {
    app.chat_widget.agent_tree_text()
}

fn status_of(rows: &[TaskRow], thread_id: ThreadId) -> Option<TaskStatus> {
    rows.iter()
        .find(|row| row.target == TreeTarget::Thread(thread_id))
        .map(|row| row.status)
}

#[tokio::test]
async fn a_running_subagent_is_on_the_tree_under_main() -> Result<()> {
    let (main, child) = (ThreadId::new(), ThreadId::new());
    let app = app_with_running_subagent(main, child).await?;

    let lines = tree(&app);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].contains("main"), "{lines:?}");
    assert!(
        lines[1].contains("◉ date_check"),
        "the subagent is working: {lines:?}"
    );
    Ok(())
}

#[tokio::test]
async fn a_finished_subagent_leaves_the_tree_but_stays_in_tasks() -> Result<()> {
    let (main, child) = (ThreadId::new(), ThreadId::new());
    let mut app = app_with_running_subagent(main, child).await?;
    app.agent_tokens.insert(child, 1_900);

    Box::pin(app.enqueue_thread_notification(
        child,
        turn_completed_notification(child, "turn-1", TurnStatus::Completed),
    ))
    .await?;

    // Inside the grace period it says it is done, rather than blinking out.
    let lines = tree(&app);
    assert!(
        lines
            .iter()
            .any(|line| line.contains("date_check") && line.contains("done")),
        "{lines:?}"
    );
    assert!(
        !lines.iter().any(|line| line.contains("/tasks")),
        "{lines:?}"
    );

    app.tasks.age_finished_agents(FINISHED_GRACE);
    app.refresh_agent_tree();
    // Gone, and the main row with it: alone it says nothing the status
    // indicator does not.
    assert_eq!(tree(&app), vec!["  1 done · /tasks".to_string()]);

    let rows = app.task_rows();
    assert_eq!(status_of(&rows, child), Some(TaskStatus::Done));
    let row = rows
        .iter()
        .find(|row| row.target == TreeTarget::Thread(child))
        .expect("the finished subagent is listed");
    assert!(row.elapsed.is_some(), "how long it took: {row:?}");
    assert_eq!(row.tokens, Some(1_900));

    // Opening /tasks is where the hint pointed; it has done its job.
    app.open_tasks();
    assert!(tree(&app).is_empty(), "{:?}", tree(&app));
    Ok(())
}

#[tokio::test]
async fn a_failed_subagent_stays_until_it_is_seen() -> Result<()> {
    let (main, child) = (ThreadId::new(), ThreadId::new());
    let mut app = app_with_running_subagent(main, child).await?;

    Box::pin(app.enqueue_thread_notification(
        child,
        turn_completed_notification(child, "turn-1", TurnStatus::Failed),
    ))
    .await?;
    app.tasks.age_finished_agents(FINISHED_GRACE);
    app.refresh_agent_tree();

    let lines = tree(&app);
    assert!(
        lines
            .iter()
            .any(|line| line.contains("✗ date_check") && line.contains("failed")),
        "{lines:?}"
    );
    assert!(
        !lines.iter().any(|line| line.contains("done · /tasks")),
        "a failure on the tree is not also counted as hidden: {lines:?}"
    );
    assert_eq!(status_of(&app.task_rows(), child), Some(TaskStatus::Failed));

    app.open_tasks();
    assert!(tree(&app).is_empty(), "{:?}", tree(&app));
    assert_eq!(
        status_of(&app.task_rows(), child),
        Some(TaskStatus::Failed),
        "/tasks still says how it ended"
    );
    Ok(())
}

#[tokio::test]
async fn show_finished_keeps_the_old_panel() -> Result<()> {
    let (main, child) = (ThreadId::new(), ThreadId::new());
    let mut app = app_with_running_subagent(main, child).await?;
    app.config.tui_agent_tree_show_finished = true;

    Box::pin(app.enqueue_thread_notification(
        child,
        turn_completed_notification(child, "turn-1", TurnStatus::Completed),
    ))
    .await?;
    app.tasks.age_finished_agents(FINISHED_GRACE);
    app.refresh_agent_tree();

    let lines = tree(&app);
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert!(lines[0].contains("main"), "{lines:?}");
    assert!(lines[1].contains("◯ date_check"), "{lines:?}");
    Ok(())
}

#[tokio::test]
async fn a_lone_main_row_is_not_shown() -> Result<()> {
    let main = ThreadId::new();
    let mut app = Box::pin(make_test_app()).await;
    app.primary_thread_id = Some(main);
    app.active_thread_id = Some(main);
    app.thread_event_channels
        .insert(main, ThreadEventChannel::new(/*capacity*/ 8));
    app.agent_navigation
        .upsert(main, None, None, /*is_closed*/ false);
    Box::pin(app.enqueue_thread_notification(main, turn_started_notification(main, "turn-1")))
        .await?;

    assert!(tree(&app).is_empty(), "{:?}", tree(&app));
    Ok(())
}
