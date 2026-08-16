use super::*;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

const A: &str = "5a6b0c0d0e0f";
const B: &str = "5a6b9a8b7c6d";

async fn runtime() -> anyhow::Result<Arc<StateRuntime>> {
    StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await
}

#[allow(clippy::too_many_arguments)]
async fn publish(
    runtime: &StateRuntime,
    task_id: &str,
    title: &str,
    priority: i64,
    assigned: Option<ThreadId>,
) -> anyhow::Result<()> {
    runtime
        .publish_session_mesh_task(
            task_id,
            "default",
            title,
            "body",
            priority,
            thread_id(A),
            assigned,
            1_000,
        )
        .await
}

#[tokio::test]
async fn a_task_is_claimed_once_even_under_concurrency() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-1", "only task", 0, None).await?;

    // Eight workers race for one task. Exactly one may win, or two sessions
    // would do the same work and both report a result.
    let mut handles = Vec::new();
    for index in 0..8 {
        let runtime = Arc::clone(&runtime);
        handles.push(tokio::spawn(async move {
            runtime
                .claim_session_mesh_task("default", thread_id(B), &format!("token-{index}"), 2_000)
                .await
        }));
    }

    let mut winners = 0;
    for handle in handles {
        if handle.await?.expect("claim should not error").is_some() {
            winners += 1;
        }
    }

    assert_eq!(winners, 1);
    Ok(())
}

#[tokio::test]
async fn an_assigned_task_is_only_claimable_by_its_assignee() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-mine", "for b", 0, Some(thread_id(B))).await?;

    let stranger = runtime
        .claim_session_mesh_task("default", thread_id(A), "token-a", 2_000)
        .await?;
    assert!(stranger.is_none(), "an assignment is not an open task");

    let assignee = runtime
        .claim_session_mesh_task("default", thread_id(B), "token-b", 2_000)
        .await?;
    assert_eq!(
        assignee.map(|task| task.task_id),
        Some("t-mine".to_string())
    );
    Ok(())
}

#[tokio::test]
async fn an_assigned_task_outranks_a_higher_priority_open_one() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-open", "urgent open work", 100, None).await?;
    publish(&runtime, "t-assigned", "for b", 0, Some(thread_id(B))).await?;

    // Assignment is a request aimed at this session; letting an open task jump
    // ahead of it would make assigning anything pointless.
    let claimed = runtime
        .claim_session_mesh_task("default", thread_id(B), "token-b", 2_000)
        .await?;

    assert_eq!(
        claimed.map(|task| task.task_id),
        Some("t-assigned".to_string())
    );
    Ok(())
}

#[tokio::test]
async fn open_tasks_are_claimed_by_priority_then_age() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-low", "low", 0, None).await?;
    publish(&runtime, "t-high", "high", 10, None).await?;

    let first = runtime
        .claim_session_mesh_task("default", thread_id(B), "token-1", 2_000)
        .await?;

    assert_eq!(first.map(|task| task.task_id), Some("t-high".to_string()));
    Ok(())
}

#[tokio::test]
async fn a_report_from_a_lost_claim_writes_nothing() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-1", "work", 0, None).await?;
    runtime
        .claim_session_mesh_task("default", thread_id(A), "token-first", 2_000)
        .await?;

    // The first claimant died and the task was reclaimed and re-claimed.
    runtime
        .reclaim_session_mesh_tasks_from(thread_id(A), 3_000)
        .await?;
    runtime
        .claim_session_mesh_task("default", thread_id(B), "token-second", 4_000)
        .await?;
    runtime
        .report_session_mesh_task(
            "t-1",
            "token-second",
            "done",
            Some("{\"ok\":true}"),
            None,
            5_000,
        )
        .await?;

    // The original worker wakes up and reports. Without the token check it
    // would overwrite the result of the session that actually finished.
    let outcome = runtime
        .report_session_mesh_task("t-1", "token-first", "failed", None, Some("stale"), 6_000)
        .await?;

    assert_eq!(outcome, TaskReportOutcome::ClaimLost);
    let tasks = runtime.list_session_mesh_tasks("default", 10).await?;
    assert_eq!(tasks[0].status, "done");
    assert_eq!(tasks[0].result_json.as_deref(), Some("{\"ok\":true}"));
    Ok(())
}

#[tokio::test]
async fn a_dead_claimants_task_returns_to_the_pool() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-1", "work", 0, None).await?;
    runtime
        .claim_session_mesh_task("default", thread_id(A), "token-a", 2_000)
        .await?;

    assert_eq!(
        runtime.session_mesh_task_claimants("default").await?,
        vec![thread_id(A)]
    );
    let requeued = runtime
        .reclaim_session_mesh_tasks_from(thread_id(A), 3_000)
        .await?;

    assert_eq!(requeued, 1);
    let tasks = runtime.list_session_mesh_tasks("default", 10).await?;
    assert_eq!(tasks[0].status, "pending");
    assert_eq!(tasks[0].claimed_by_thread_id, None);
    // The attempt is still counted, which is what eventually stops a task that
    // kills whoever claims it.
    assert_eq!(tasks[0].attempt_count, 1);
    Ok(())
}

#[tokio::test]
async fn a_task_that_keeps_killing_its_claimant_eventually_fails() -> anyhow::Result<()> {
    let runtime = runtime().await?;
    publish(&runtime, "t-poison", "crashes everything", 0, None).await?;

    for attempt in 0..3 {
        runtime
            .claim_session_mesh_task("default", thread_id(A), &format!("token-{attempt}"), 2_000)
            .await?;
        runtime
            .reclaim_session_mesh_tasks_from(thread_id(A), 3_000)
            .await?;
    }

    let tasks = runtime.list_session_mesh_tasks("default", 10).await?;
    assert_eq!(tasks[0].status, "failed");
    assert!(
        tasks[0]
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("ran out of attempts")),
        "{:?}",
        tasks[0].last_error
    );
    // A failed task must not come back, or it would cycle forever.
    assert!(
        runtime
            .claim_session_mesh_task("default", thread_id(B), "token-x", 4_000)
            .await?
            .is_none()
    );
    Ok(())
}

#[tokio::test]
async fn an_empty_queue_claims_nothing() -> anyhow::Result<()> {
    let runtime = runtime().await?;

    assert!(
        runtime
            .claim_session_mesh_task("default", thread_id(A), "token", 1_000)
            .await?
            .is_none()
    );
    Ok(())
}
