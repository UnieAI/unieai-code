// Copyright (c) 2026 UnieAI. All rights reserved.
//! A thread is a session-mesh peer only while a client shows it.
//!
//! The TUI keeps a thread loaded for a while after `/new` or a thread switch.
//! If that thread stayed in the mesh, other sessions saw the same session
//! listed several times, and a message to the wrong entry started a turn the
//! user never saw.

use std::time::Duration;

use anyhow::Result;
use app_test_support::MockResponsesConfig;
use app_test_support::TestAppServer;
use app_test_support::create_mock_responses_server_repeating_assistant;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::ThreadResumeParams;
use codex_app_server_protocol::ThreadResumeResponse;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::ThreadUnsubscribeParams;
use codex_app_server_protocol::ThreadUnsubscribeResponse;
use codex_app_server_protocol::ThreadUnsubscribeStatus;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::UserInput as V2UserInput;
use codex_utils_absolute_path::test_support::PathExt;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

const PRESENCE_TIMEOUT: Duration = Duration::from_secs(10);

/// Thread ids currently registered in the mesh.
async fn mesh_members(state_db: &codex_state::StateRuntime) -> Result<Vec<String>> {
    Ok(state_db
        .list_session_mesh_peers()
        .await?
        .into_iter()
        .map(|row| row.peer.thread_id.to_string())
        .collect())
}

/// Waits until `thread_id`'s membership is `expected`.
async fn wait_for_membership(
    state_db: &codex_state::StateRuntime,
    thread_id: &str,
    expected: bool,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + PRESENCE_TIMEOUT;
    loop {
        let members = mesh_members(state_db).await?;
        if members.iter().any(|member| member == thread_id) == expected {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("thread {thread_id} membership never became {expected}: {members:?}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_thread_no_client_shows_leaves_the_mesh_and_rejoins_when_shown_again() -> Result<()> {
    let server = create_mock_responses_server_repeating_assistant("Done").await;
    let codex_home = TempDir::new()?;
    MockResponsesConfig::new(&server.uri())
        .with_sandbox_mode("danger-full-access")
        // Long enough that unloading cannot be what removes the thread.
        .with_root_config("thread_unload_delay_secs = 600")
        .write(codex_home.path())?;

    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .build_initialized()
        .await?;
    let state_db = codex_state::StateRuntime::init(
        codex_state::SqliteConfig::new_for_testing(codex_home.path().abs()),
        "mock_provider".into(),
    )
    .await?;

    let ThreadStartResponse { thread, .. } = mcp
        .start_thread(ThreadStartParams {
            model: Some("mock-model".to_string()),
            ..Default::default()
        })
        .await?;
    let thread_id = thread.id;
    wait_for_membership(&state_db, &thread_id, /*expected*/ true).await?;
    // A turn persists the rollout, so the thread can be resumed below.
    tokio::time::timeout(
        PRESENCE_TIMEOUT,
        mcp.start_turn_and_wait_for_completion(TurnStartParams {
            thread_id: thread_id.clone(),
            input: vec![V2UserInput::Text {
                text: "hello".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        }),
    )
    .await??;

    let unsubscribe: ThreadUnsubscribeResponse = mcp
        .request(|request_id| ClientRequest::ThreadUnsubscribe {
            request_id,
            params: ThreadUnsubscribeParams {
                thread_id: thread_id.clone(),
            },
        })
        .await?;
    assert_eq!(unsubscribe.status, ThreadUnsubscribeStatus::Unsubscribed);
    wait_for_membership(&state_db, &thread_id, /*expected*/ false).await?;

    let resume: ThreadResumeResponse = mcp
        .request(|request_id| ClientRequest::ThreadResume {
            request_id,
            params: ThreadResumeParams {
                thread_id: thread_id.clone(),
                ..Default::default()
            },
        })
        .await?;
    assert_eq!(resume.thread.id, thread_id);
    wait_for_membership(&state_db, &thread_id, /*expected*/ true).await?;

    Ok(())
}
