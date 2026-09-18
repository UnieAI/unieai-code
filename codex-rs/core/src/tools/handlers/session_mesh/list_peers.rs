use super::*;
use crate::tools::handlers::session_mesh_spec::create_list_peers_tool;
use unieai_session_mesh::unieai_tools::ListPeersResult;

pub(crate) struct Handler;

impl ToolExecutor<ToolInvocation> for Handler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("list_peers")
    }

    fn spec(&self) -> ToolSpec {
        create_list_peers_tool()
    }

    fn handle<'a>(&'a self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'a>
    where
        ToolInvocation: 'a,
    {
        Box::pin(self.handle_call(invocation))
    }
}

impl Handler {
    async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn ToolOutput>, FunctionCallError> {
        let ToolInvocation {
            session, payload, ..
        } = invocation;
        let arguments = function_arguments(payload)?;
        let _args: ListPeersArgs = parse_arguments(&arguments)?;

        // Listing probes every candidate, so the answer reflects who is
        // reachable now rather than who once registered.
        let peers = mesh_node(&session.services)
            .await?
            .list_peers()
            .await
            .map_err(mesh_error)?;

        Ok(boxed_tool_output(ListPeersOutput(ListPeersResult {
            peers: unieai_session_mesh::unieai_tools::listed_peers(&peers),
        })))
    }
}

impl CoreToolRuntime for Handler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPeersArgs {}

/// The engine-neutral result, wrapped so core can implement its output trait.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub(crate) struct ListPeersOutput(ListPeersResult);

impl ToolOutput for ListPeersOutput {
    fn log_output(&self) -> String {
        tool_output_json_text(self, "list_peers")
    }

    fn success_for_logging(&self) -> bool {
        true
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(call_id, payload, self, Some(true), "list_peers")
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(self, "list_peers")
    }
}
