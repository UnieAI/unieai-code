use super::*;
use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use std::collections::BTreeMap;

pub(crate) struct SpawnPeerSessionHandler;

pub fn create_spawn_peer_session_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "prompt".to_string(),
            JsonSchema::string(Some(
                "Everything the background session needs to do the work on its own. It cannot ask \
you questions."
                    .to_string(),
            )),
        ),
        (
            "cwd".to_string(),
            JsonSchema::string(Some(
                "Working directory for the background session, inside your workspace. Defaults to \
yours."
                    .to_string(),
            )),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "spawn_peer_session".to_string(),
        description: "Start a background UnieAI Code session in a SEPARATE PROCESS. \
This is expensive and rarely what you want: the new process pays full CLI startup, has its own \
token budget, and cannot be waited on or interrupted by you. Use it ONLY when the work must \
outlive this session, run in a different workspace, or be reachable from another terminal. \
For anything you intend to wait for or supervise — which is almost all delegated work — use \
spawn_agent instead. The user must approve the launch, and the new session runs with your \
sandbox and cannot ask for approvals. When the background session finishes it sends you its result, which you see \
at the start of a later turn; it is also visible to list_peers and can be messaged like any peer."
            .to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["prompt".to_string()]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnPeerSessionArgs {
    prompt: String,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SpawnPeerSessionResult {
    handle: String,
    pid: u32,
    /// Where the child's output goes. A detached process has no terminal, so
    /// this is the only place a startup failure is visible.
    log_path: String,
}

impl ToolExecutor<ToolInvocation> for SpawnPeerSessionHandler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("spawn_peer_session")
    }

    fn spec(&self) -> ToolSpec {
        create_spawn_peer_session_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(async move {
            let ToolInvocation {
                session,
                turn,
                payload,
                call_id,
                ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: SpawnPeerSessionArgs = parse_arguments(&arguments)?;

            if args.prompt.trim().is_empty() {
                return Err(FunctionCallError::RespondToModel(
                    "`prompt` must not be empty".to_string(),
                ));
            }

            // The child starts in this session's workspace or below it, never
            // somewhere this session was not already working.
            #[allow(deprecated)]
            let workspace = turn.cwd.clone();
            let cwd = match args.cwd.as_deref() {
                None => workspace.to_path_buf(),
                Some(requested) => {
                    let requested = workspace.as_path().join(requested);
                    let resolved = requested.canonicalize().map_err(|err| {
                        FunctionCallError::RespondToModel(format!(
                            "`cwd` {} is not usable: {err}",
                            requested.display()
                        ))
                    })?;
                    let root = workspace
                        .as_path()
                        .canonicalize()
                        .unwrap_or_else(|_| workspace.to_path_buf());
                    if !resolved.starts_with(&root) {
                        return Err(FunctionCallError::RespondToModel(format!(
                            "`cwd` must be inside this session's workspace ({})",
                            root.display()
                        )));
                    }
                    resolved
                }
            };

            // The child inherits this turn's sandbox. It runs headless, so it
            // cannot ask for approval either: anything outside the sandbox
            // fails rather than escalating.
            let sandbox_mode = crate::session::mesh::turn_permission_mode(&turn)
                .sandbox
                .as_str()
                .to_string();
            let exe = std::env::current_exe()
                .map(|exe| exe.display().to_string())
                .unwrap_or_else(|_| "unieai".to_string());
            let command = vec![
                exe,
                "exec".to_string(),
                "--sandbox".to_string(),
                sandbox_mode.clone(),
                args.prompt.clone(),
            ];

            // Launching a detached process is always the user's call.
            let decision = session
                .request_command_approval(
                    turn.as_ref(),
                    codex_protocol::approvals::ExecApprovalKind::Command,
                    crate::guardian::GuardianReviewContext::from(std::sync::Arc::clone(&turn))
                        .model_context(),
                    call_id,
                    /*approval_id*/ None,
                    /*environment_id*/ None,
                    command,
                    codex_utils_absolute_path::AbsolutePathBuf::from_absolute_path(&cwd)
                        .unwrap_or_else(|_| workspace.clone())
                        .into(),
                    Some(
                        "Start a background UnieAI Code session in a separate process with this \
session's sandbox. It keeps running after this session ends."
                            .to_string(),
                    ),
                    /*network_approval_context*/ None,
                    /*proposed_execpolicy_amendment*/ None,
                    /*additional_permissions*/ None,
                    Some(vec![
                        codex_protocol::protocol::ReviewDecision::Approved,
                        codex_protocol::protocol::ReviewDecision::Abort,
                    ]),
                    /*plugin_attribution_override*/ None,
                )
                .await;
            if !matches!(
                decision,
                codex_protocol::protocol::ReviewDecision::Approved
                    | codex_protocol::protocol::ReviewDecision::ApprovedForSession
            ) {
                return Err(FunctionCallError::RespondToModel(
                    "the user did not approve starting a background session".to_string(),
                ));
            }

            let node = mesh_node(&session.services).await?;
            let spawned = node
                .sender()
                .spawn_child(unieai_session_mesh::SpawnChildParams {
                    prompt: args.prompt,
                    cwd: Some(cwd),
                    sandbox_mode: Some(sandbox_mode),
                })
                .await
                .map_err(mesh_error)?;

            // Reported as a handle rather than a raw id so the model can pass
            // it straight back to send_peer_message.
            let peers = node.list_peers().await.map_err(mesh_error)?;
            let handle = peers
                .iter()
                .find(|peer| peer.thread_id == spawned.thread_id)
                .map(|peer| peer.display_handle(unieai_session_mesh::short_ref_display_len(&peers)))
                .unwrap_or_else(|| spawned.thread_id.to_string());

            Ok(boxed_tool_output(SpawnPeerSessionResult {
                handle,
                pid: spawned.pid,
                log_path: spawned.log_path.display().to_string(),
            }))
        })
    }
}

impl CoreToolRuntime for SpawnPeerSessionHandler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

impl ToolOutput for SpawnPeerSessionResult {
    fn log_output(&self) -> String {
        tool_output_json_text(self, "spawn_peer_session")
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(call_id, payload, self, Some(true), "spawn_peer_session")
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(self, "spawn_peer_session")
    }
}
