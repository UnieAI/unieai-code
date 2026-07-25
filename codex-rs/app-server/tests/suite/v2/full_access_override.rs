//! Reproduction for the `/permissions -> Full Access` runtime switch.
//!
//! The TUI implements that switch by sending a standalone
//! `thread/settings/update` with `approval_policy = never` and
//! `permissions = ":danger-full-access"` (the built-in full-access profile id),
//! then letting the NEXT plain user turn inherit those settings. This test
//! drives the exact same app-server RPCs and asserts the follow-up turn runs a
//! shell command WITHOUT emitting an approval request. If the override fails to
//! apply, the turn blocks on `item/commandExecution/requestApproval` and this
//! test times out.

use anyhow::Context;
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence;
use app_test_support::create_shell_command_sse_response;
use app_test_support::to_response;
use codex_app_server_protocol::ApprovalsReviewer;
use codex_app_server_protocol::AskForApproval;
use codex_app_server_protocol::JSONRPCResponse;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ThreadSettingsUpdateParams;
use codex_app_server_protocol::ThreadStartParams;
use codex_app_server_protocol::ThreadStartResponse;
use codex_app_server_protocol::TurnStartParams;
use codex_app_server_protocol::UserInput as V2UserInput;
use core_test_support::skip_if_wine_exec;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn full_access_override_disables_approval_for_next_turn() -> Result<()> {
    skip_if_wine_exec!(
        Ok(()),
        "full-access override exec currently rejects the target-native Windows cwd on the Linux host"
    );

    let codex_home = tempfile::TempDir::new()?;

    // The turn AFTER the override runs a shell command; under the original
    // on-request + workspace-write session it would require approval.
    let responses = vec![
        create_shell_command_sse_response(
            vec!["echo".to_string(), "hi".to_string()],
            /*workdir*/ None,
            /*timeout_ms*/ Some(5_000),
            "call1",
        )?,
        create_final_assistant_message_sse_response("done")?,
    ];
    let server = create_mock_responses_server_sequence(responses).await;
    create_config_toml(codex_home.path(), &server.uri())?;

    let mut mcp = TestAppServer::builder()
        .with_codex_home(codex_home.path())
        .build()
        .await?;
    timeout(DEFAULT_READ_TIMEOUT, mcp.initialize()).await??;

    let thread_start_id = mcp
        .send_thread_start_request_with_auto_env(ThreadStartParams {
            model: Some("mock-model".to_string()),
            ..Default::default()
        })
        .await?;
    let thread_start_resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(thread_start_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response(thread_start_resp)?;

    // Exactly what `/permissions -> Full Access` sends: a standalone settings
    // update selecting the built-in full-access profile and disabling approval.
    let settings_id = mcp
        .send_thread_settings_update_request(ThreadSettingsUpdateParams {
            thread_id: thread.id.clone(),
            approval_policy: Some(AskForApproval::Never),
            approvals_reviewer: Some(ApprovalsReviewer::User),
            permissions: Some(":danger-full-access".to_string()),
            ..Default::default()
        })
        .await?;
    let _settings_resp: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(settings_id)),
    )
    .await
    .context("thread/settings/update did not respond")??;

    // Next plain user turn — no per-turn overrides, so it must inherit the
    // full-access settings from the standalone update above.
    let _turn_start_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id.clone(),
            client_user_message_id: None,
            input: vec![V2UserInput::Text {
                text: "run echo".to_string(),
                text_elements: Vec::new(),
            }],
            model: Some("mock-model".to_string()),
            ..Default::default()
        })
        .await?;

    // If the override applied, the shell command auto-runs (approval=Never) and
    // the turn completes. If it did NOT apply, the turn blocks on an approval
    // request and this wait times out.
    timeout(
        DEFAULT_READ_TIMEOUT,
        mcp.read_stream_until_matching_notification("turn/completed", |notification| {
            notification.method == "turn/completed"
        }),
    )
    .await
    .context(
        "turn did not complete without approval — the Full Access override was not applied to \
         the next turn",
    )??;

    Ok(())
}

fn create_config_toml(codex_home: &std::path::Path, server_uri: &str) -> std::io::Result<()> {
    let config_toml = codex_home.join("config.toml");
    std::fs::write(
        config_toml,
        format!(
            r#"
model = "mock-model"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

model_provider = "mock_provider"

[model_providers.mock_provider]
name = "Mock provider for test"
base_url = "{server_uri}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#
        ),
    )
}
