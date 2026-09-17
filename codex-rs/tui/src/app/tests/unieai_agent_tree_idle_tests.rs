// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use codex_app_server_protocol::ThreadStatus;
use codex_app_server_protocol::ThreadStatusChangedNotification;
use pretty_assertions::assert_eq;

async fn app_with_running_agent(thread_id: ThreadId) -> Result<Box<App>> {
    let mut app = Box::new(Box::pin(make_test_app()).await);
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
