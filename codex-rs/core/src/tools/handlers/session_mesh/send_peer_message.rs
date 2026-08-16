use super::*;
use crate::tools::handlers::session_mesh_spec::create_send_peer_message_tool;
use unieai_session_mesh::PeerSelector;

pub(crate) struct Handler;

impl ToolExecutor<ToolInvocation> for Handler {
    fn tool_name(&self) -> ToolName {
        ToolName::plain("send_peer_message")
    }

    fn spec(&self) -> ToolSpec {
        create_send_peer_message_tool()
    }

    fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_> {
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

        // Relays carry a hop count so two sessions answering each other cannot
        // burn tokens in both terminals unattended. A turn started by a peer
        // message therefore sends onward at hop+1.
        let hop = peer_message_hop(&turn);
        let selector = PeerSelector::new(args.target.clone());

        let node = mesh_node(&session.services).await?;
        let peer = node.resolve(&selector).await.map_err(mesh_error)?;
        let ack = node
            .send_message(&peer, &args.message, !args.queue_only, hop)
            .await
            .map_err(mesh_error)?;

        Ok(boxed_tool_output(SendPeerMessageResult {
            accepted: ack.accepted,
            // Reported verbatim: telling the model a turn started when the peer
            // merely queued the message is the failure this whole design exists
            // to avoid.
            delivery: ack.delivery.as_str().to_string(),
            note: ack.reject_reason,
        }))
    }
}

/// Hop count to stamp on an outgoing peer message.
///
/// A turn that a peer started is one hop further along the chain than a turn
/// the user started, so anything it sends onward must carry that distance.
fn peer_message_hop(turn: &crate::session::turn_context::TurnContext) -> u32 {
    if turn.session_source.is_non_root_agent() {
        1
    } else {
        0
    }
}

impl CoreToolRuntime for Handler {
    fn matches_kind(&self, payload: &ToolPayload) -> bool {
        matches!(payload, ToolPayload::Function { .. })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SendPeerMessageArgs {
    target: String,
    message: String,
    #[serde(default)]
    queue_only: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct SendPeerMessageResult {
    accepted: bool,
    /// `started_turn`, `queued`, or `rejected`.
    delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl ToolOutput for SendPeerMessageResult {
    fn log_preview(&self) -> String {
        tool_output_json_text(self, "send_peer_message")
    }

    fn success_for_logging(&self) -> bool {
        self.accepted
    }

    fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem {
        tool_output_response_item(
            call_id,
            payload,
            self,
            Some(self.accepted),
            "send_peer_message",
        )
    }

    fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue {
        tool_output_code_mode_result(self, "send_peer_message")
    }
}
