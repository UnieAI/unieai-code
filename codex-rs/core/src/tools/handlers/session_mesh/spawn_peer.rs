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
                "Working directory for the background session. Defaults to yours.".to_string(),
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
spawn_agent instead. When the background session finishes it sends you its result, which you see \
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

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
        Box::pin(async move {
            let ToolInvocation {
                session, payload, ..
            } = invocation;
            let arguments = function_arguments(payload)?;
            let args: SpawnPeerSessionArgs = parse_arguments(&arguments)?;

            if args.prompt.trim().is_empty() {
                return Err(FunctionCallError::RespondToModel(
                    "`prompt` must not be empty".to_string(),
                ));
            }

            let node = mesh_node(&session.services).await?;
            let spawned = node
                .sender()
                .spawn_child(unieai_session_mesh::SpawnChildParams {
                    prompt: args.prompt,
                    cwd: args.cwd.map(std::path::PathBuf::from),
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
    fn log_preview(&self) -> String {
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
