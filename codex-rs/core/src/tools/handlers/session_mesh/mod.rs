//! Model-callable tools for the machine-local session mesh.

use crate::function_tool::FunctionCallError;
use crate::tools::context::ToolInvocation;
use crate::tools::context::ToolOutput;
use crate::tools::context::ToolPayload;
use crate::tools::context::boxed_tool_output;
use crate::tools::handlers::multi_agents_common::function_arguments;
use crate::tools::handlers::multi_agents_common::tool_output_code_mode_result;
use crate::tools::handlers::multi_agents_common::tool_output_json_text;
use crate::tools::handlers::multi_agents_common::tool_output_response_item;
use crate::tools::handlers::parse_arguments;
use crate::tools::registry::CoreToolRuntime;
use crate::tools::registry::ToolExecutor;
use codex_protocol::models::ResponseInputItem;
use codex_tools::ToolName;
use codex_tools::ToolSpec;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use unieai_session_mesh::MeshError;
use unieai_session_mesh::MeshNode;
use unieai_session_mesh::PeerHandle;
use unieai_session_mesh::short_ref_display_len;

pub(crate) use list_peers::Handler as ListPeersHandler;
pub(crate) use send_peer_message::Handler as SendPeerMessageHandler;
pub(crate) use spawn_peer::SpawnPeerSessionHandler;
pub(crate) use tasks::ClaimTaskHandler;
pub(crate) use tasks::ListTasksHandler;
pub(crate) use tasks::PublishTaskHandler;
pub(crate) use tasks::ReportTaskHandler;

mod list_peers;
mod send_peer_message;
mod spawn_peer;
mod tasks;

/// Takes a handle to this session's mesh membership.
///
/// The node is cloned out so the caller holds no lock while awaiting: mesh
/// calls do socket I/O, and keeping the guard across them would serialise
/// every peer operation behind the slowest probe.
///
/// A session that never joined is not an error state to paper over: it means
/// the feature is off, the state database is missing, or the platform is
/// unsupported. Saying so plainly is what keeps "no peers" distinguishable
/// from "the mesh is not working here".
async fn mesh_node(
    services: &crate::state::SessionServices,
) -> Result<Arc<MeshNode>, FunctionCallError> {
    let node = services.session_mesh.lock().await.clone();
    node.ok_or_else(|| {
        FunctionCallError::RespondToModel(
            "the session mesh is not available in this session (it is disabled, or this host has \
no local state database)"
                .to_string(),
        )
    })
}

/// Turns a mesh failure into text the model can act on.
///
/// Ambiguity in particular must arrive with its candidate list intact: it is
/// the one error the model can fix on its own, by re-sending with a bracketed
/// handle.
fn mesh_error(err: MeshError) -> FunctionCallError {
    FunctionCallError::RespondToModel(err.to_string())
}

/// A peer as the model sees it.
#[derive(Debug, Serialize)]
pub(crate) struct ListedPeer {
    /// The exact string to pass back as `target`.
    handle: String,
    status: String,
    cwd: String,
}

fn listed_peers(peers: &[PeerHandle]) -> Vec<ListedPeer> {
    let width = short_ref_display_len(peers);
    peers
        .iter()
        .map(|peer| ListedPeer {
            handle: peer.display_handle(width),
            status: peer.status.as_str().to_string(),
            cwd: peer.cwd.display().to_string(),
        })
        .collect()
}
