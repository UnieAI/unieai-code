use super::*;
use crate::tools::handlers::session_mesh_spec::create_send_peer_message_tool;
use unieai_session_mesh::PeerSelector;
use unieai_session_mesh::unieai_tools::SendPeerMessageArgs;
use unieai_session_mesh::unieai_tools::SendPeerMessageResult;

pub(crate) struct Handler;

impl ToolExecutor<ToolInvocation> for Handler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("send_peer_message")
    }

    fn spec(&self) -> ToolSpec {
        create_send_peer_message_tool()
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
            session,
            turn,
            payload,
            ..
        } = invocation;
        let arguments = function_arguments(payload)?;
        let args: SendPeerMessageArgs = parse_arguments(&arguments)?;

        if args.message.trim().is_empty() {
            return Err(FunctionCallError::RespondToModel(
                "`message` must not be empty".to_string(),
            ));
        }

        let selector = PeerSelector::new(args.target.clone());
        let node = mesh_node(&session.services).await?;
        // Relays carry a hop count so two sessions answering each other cannot
        // burn tokens in both terminals unattended: anything sent after a peer
        // message arrived, and before this session's user spoke again, goes
        // out one hop further than that message.
        let hop = node.outbound_hop();
        // Stamped so the recipient can hold the message if it runs with
        // broader permissions than this turn.
        let permissions = crate::session::mesh::turn_permission_mode(&turn);
        let peer = node.resolve(&selector).await.map_err(mesh_error)?;
        let ack = node
            .send_message(
                &peer,
                &args.message,
                !args.queue_only,
                hop,
                Some(permissions),
            )
            .await
            .map_err(mesh_error)?;

        Ok(boxed_tool_output(SendPeerMessageOutput(
            SendPeerMessageResult::from(ack),
        )))
    }
}

impl CoreToolRuntime for Handler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

/// The engine-neutral result, wrapped so core can implement its output trait.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub(crate) struct SendPeerMessageOutput(SendPeerMessageResult);

impl ToolOutput for SendPeerMessageOutput {
    fn log_output(&self) -> String {
        tool_output_json_text(self, "send_peer_message")
    }

    fn success_for_logging(&self) -> bool {
        self.0.accepted
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(
            call_id,
            payload,
            self,
            Some(self.0.accepted),
            "send_peer_message",
        )
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(self, "send_peer_message")
    }
}
