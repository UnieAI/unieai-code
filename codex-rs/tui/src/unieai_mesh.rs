// Copyright (c) 2026 UnieAI. All rights reserved.
//! Session-mesh membership for threads that run on the uac engine, plus the
//! pieces every TUI peer surface shares (permission stamp, engine name).
//!
//! A codex-engine thread joins the mesh from core, when its `Session` is
//! built. A uac thread never builds one — deepseek-harness runs the turn — so
//! the TUI joins on its behalf, with the same crate, socket directory, store,
//! wire protocol, framing, and permission-hold rule:
//!
//! * Inbound messages become [`AppEvent::UacPeerInbound`]. The app starts a
//!   turn when the thread is idle, steers the running turn when it is busy,
//!   and otherwise keeps the text for the user's next turn; the answer is
//!   reported back to the sender as the delivery outcome.
//! * `list_peers` / `send_peer_message` are offered to the model as
//!   `codex_tui` dynamic tools at `thread/start`, with the same names,
//!   argument shapes, and result shapes as the core tools
//!   ([`unieai_session_mesh::unieai_tools`]); the app answers the calls here.
//!
//! The membership lasts as long as this TUI shows the thread, like one
//! process = one member in Claude Code.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use codex_app_server_protocol::DynamicToolCallOutputContentItem;
use codex_app_server_protocol::DynamicToolCallResponse;
use codex_app_server_protocol::DynamicToolFunctionSpec;
use codex_app_server_protocol::DynamicToolNamespaceTool;
use codex_protocol::ThreadId;
use codex_protocol::protocol::AskForApproval;
use serde_json::Value;
use tokio::sync::oneshot;
use unieai_session_mesh::ApprovalLevel;
use unieai_session_mesh::InboundDecision;
use unieai_session_mesh::InboundFuture;
use unieai_session_mesh::InboundMessage;
use unieai_session_mesh::LocalSessionIdentity;
use unieai_session_mesh::LocalSnapshot;
use unieai_session_mesh::MeshConfig;
use unieai_session_mesh::MeshError;
use unieai_session_mesh::MeshInbound;
use unieai_session_mesh::MeshNode;
use unieai_session_mesh::MeshSender;
use unieai_session_mesh::MeshStore;
use unieai_session_mesh::PeerHandle;
use unieai_session_mesh::PeerSelector;
use unieai_session_mesh::PermissionMode;
use unieai_session_mesh::SandboxLevel;
use unieai_session_mesh::StateRuntimeStore;
use unieai_session_mesh::unieai_tools;
use unieai_session_mesh::wire::Delivery;

use crate::app_event::AppEvent;
use crate::app_event_sender::AppEventSender;
use crate::legacy_core::config::Config;

/// Engine names stamped on outgoing messages and shown in the framing.
pub(crate) const ENGINE_CODEX: &str = "codex";
pub(crate) const ENGINE_UAC: &str = "uac";

/// Marks a turn the app started to deliver a peer's message, so it is not
/// mistaken for the user speaking.
const PEER_DELIVERY_ID_PREFIX: &str = "peer-mesh-";

/// How long a peer waits for the app to act on its message before the
/// delivery is reported as queued.
const INBOUND_REPLY_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a probe waits for the app to say whether the thread is busy.
const PROBE_REPLY_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) fn peer_delivery_client_id() -> String {
    format!("{PEER_DELIVERY_ID_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Whether a turn's client id marks it as a peer delivery rather than input
/// from the user.
pub(crate) fn is_peer_delivery_client_id(client_user_message_id: &str) -> bool {
    client_user_message_id.starts_with(PEER_DELIVERY_ID_PREFIX)
}

/// This TUI's permission mode as the mesh ranks it (see
/// `unieai_session_mesh::unieai_permissions`): the sandbox the next turn
/// would get and the approval policy.
pub(crate) fn permission_mode_for_config(config: &Config) -> PermissionMode {
    let sandbox = match crate::app_server_session::sandbox_mode_from_permission_profile(
        &config.permissions.effective_permission_profile(),
        config.cwd.as_path(),
    ) {
        Some(codex_app_server_protocol::SandboxMode::ReadOnly) => SandboxLevel::ReadOnly,
        Some(codex_app_server_protocol::SandboxMode::WorkspaceWrite) => {
            SandboxLevel::WorkspaceWrite
        }
        // An external sandbox is not something this process can vouch for.
        Some(codex_app_server_protocol::SandboxMode::DangerFullAccess) | None => {
            SandboxLevel::FullAccess
        }
    };
    let approval = match config.permissions.approval_policy.value() {
        AskForApproval::UnlessTrusted => ApprovalLevel::Untrusted,
        AskForApproval::OnRequest | AskForApproval::Granular(_) => ApprovalLevel::OnRequest,
        AskForApproval::Never => ApprovalLevel::Never,
    };
    PermissionMode::new(sandbox, approval)
}

/// A sender for this TUI's thread, stamped with the engine it runs on.
pub(crate) fn sender_for(
    config: &Config,
    state_db: codex_rollout::StateDbHandle,
    thread_id: ThreadId,
    engine: &str,
) -> MeshSender {
    MeshSender::new(
        MeshConfig::new(config.codex_home.to_path_buf()),
        thread_id,
        env!("CARGO_PKG_VERSION").to_string(),
        Arc::new(StateRuntimeStore::new(state_db)) as Arc<dyn MeshStore>,
    )
    .with_engine(engine)
}

/// A finished join, carried back to the app in an event.
pub(crate) struct JoinedMember(pub(crate) Arc<UacMeshMember>);

impl std::fmt::Debug for JoinedMember {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JoinedMember")
            .field("thread_id", &self.0.thread_id)
            .finish_non_exhaustive()
    }
}

/// A uac thread's membership, owned by the app.
pub(crate) struct UacMeshMember {
    pub(crate) thread_id: ThreadId,
    pub(crate) node: Arc<MeshNode>,
    mode: Arc<Mutex<PermissionMode>>,
}

impl UacMeshMember {
    /// Binds the thread's socket and publishes it, then delivers anything
    /// left for it while it was not running.
    pub(crate) async fn join(
        config: &Config,
        state_db: codex_rollout::StateDbHandle,
        thread_id: ThreadId,
        app_event_tx: AppEventSender,
    ) -> Result<Self, MeshError> {
        let mode = Arc::new(Mutex::new(permission_mode_for_config(config)));
        let inbound = Arc::new(UacInbound {
            thread_id,
            app_event_tx,
            mode: Arc::clone(&mode),
        });
        let node = MeshNode::join(
            MeshConfig::new(config.codex_home.to_path_buf()),
            LocalSessionIdentity {
                thread_id,
                cwd: config.cwd.to_path_buf(),
                session_source: "cli".to_string(),
                cli_version: env!("CARGO_PKG_VERSION").to_string(),
                engine: ENGINE_UAC.to_string(),
                spawn_id: None,
                spawned_by: None,
            },
            Arc::new(StateRuntimeStore::new(state_db)) as Arc<dyn MeshStore>,
            inbound as Arc<dyn MeshInbound>,
        )
        .await?;
        let node = Arc::new(node);
        let pickup = Arc::clone(&node);
        tokio::spawn(async move {
            pickup.deliver_pending().await;
        });
        Ok(Self {
            thread_id,
            node,
            mode,
        })
    }

    /// Keeps the permission mode peers are compared against current.
    pub(crate) fn set_mode(&self, mode: PermissionMode) {
        *self.mode.lock().unwrap_or_else(PoisonError::into_inner) = mode;
    }

    pub(crate) fn mode(&self) -> PermissionMode {
        *self.mode.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Hands inbound messages and probes to the app, which owns the thread.
struct UacInbound {
    thread_id: ThreadId,
    app_event_tx: AppEventSender,
    mode: Arc<Mutex<PermissionMode>>,
}

impl MeshInbound for UacInbound {
    fn on_message<'a>(
        &'a self,
        from: PeerHandle,
        message: InboundMessage,
    ) -> InboundFuture<'a, InboundDecision> {
        Box::pin(async move {
            let (reply, answer) = oneshot::channel();
            self.app_event_tx.send(AppEvent::UacPeerInbound {
                thread_id: self.thread_id,
                text: unieai_session_mesh::frame_inbound(&from, &message),
                trigger_turn: message.trigger_turn,
                reply,
            });
            match tokio::time::timeout(INBOUND_REPLY_TIMEOUT, answer).await {
                Ok(Ok(delivery)) => InboundDecision::Accepted { delivery },
                Ok(Err(_)) => InboundDecision::Rejected {
                    reason: "the session closed before the message could be delivered".to_string(),
                },
                // The event is still queued in the app and will be acted on.
                Err(_) => InboundDecision::Accepted {
                    delivery: Delivery::Queued,
                },
            }
        })
    }

    fn on_probe(&self) -> InboundFuture<'_, LocalSnapshot> {
        Box::pin(async move {
            let (reply, answer) = oneshot::channel();
            self.app_event_tx.send(AppEvent::UacPeerProbe {
                thread_id: self.thread_id,
                reply,
            });
            let status = match tokio::time::timeout(PROBE_REPLY_TIMEOUT, answer).await {
                Ok(Ok(true)) => "working",
                Ok(Ok(false)) => "idle",
                _ => "unknown",
            };
            LocalSnapshot {
                status: status.to_string(),
                cli_version: env!("CARGO_PKG_VERSION").to_string(),
            }
        })
    }

    fn permission_mode(&self) -> InboundFuture<'_, Option<PermissionMode>> {
        Box::pin(async move { Some(*self.mode.lock().unwrap_or_else(PoisonError::into_inner)) })
    }
}

/// Whether `tool` in the `codex_tui` namespace is one of the peer tools.
pub(crate) fn is_peer_tool(tool: &str) -> bool {
    matches!(
        tool,
        unieai_tools::LIST_PEERS_TOOL | unieai_tools::SEND_PEER_MESSAGE_TOOL
    )
}

/// The peer tools as `codex_tui` namespace entries for a uac thread's
/// `thread/start`. Not deferred: a model that has to discover them first
/// rarely thinks to.
pub(crate) fn peer_dynamic_tools() -> Vec<DynamicToolNamespaceTool> {
    vec![
        DynamicToolNamespaceTool::Function(DynamicToolFunctionSpec {
            name: unieai_tools::LIST_PEERS_TOOL.to_string(),
            description: unieai_tools::LIST_PEERS_DESCRIPTION.to_string(),
            input_schema: unieai_tools::list_peers_input_schema(),
            defer_loading: false,
        }),
        DynamicToolNamespaceTool::Function(DynamicToolFunctionSpec {
            name: unieai_tools::SEND_PEER_MESSAGE_TOOL.to_string(),
            description: unieai_tools::SEND_PEER_MESSAGE_DESCRIPTION.to_string(),
            input_schema: unieai_tools::send_peer_message_input_schema(),
            defer_loading: false,
        }),
    ]
}

/// Runs one peer tool call for the member thread.
pub(crate) async fn execute_peer_tool(
    node: Arc<MeshNode>,
    permissions: PermissionMode,
    tool: &str,
    arguments: Value,
) -> DynamicToolCallResponse {
    let result = match tool {
        unieai_tools::LIST_PEERS_TOOL => node
            .list_peers()
            .await
            .map_err(|err| err.to_string())
            .and_then(|peers| {
                serde_json::to_string(&unieai_tools::ListPeersResult {
                    peers: unieai_tools::listed_peers(&peers),
                })
                .map_err(|err| err.to_string())
            }),
        unieai_tools::SEND_PEER_MESSAGE_TOOL => send(node, permissions, arguments).await,
        other => Err(format!("unknown peer tool {other}")),
    };
    match result {
        Ok(text) => DynamicToolCallResponse {
            content_items: vec![DynamicToolCallOutputContentItem::InputText { text }],
            success: true,
        },
        Err(message) => DynamicToolCallResponse {
            content_items: vec![DynamicToolCallOutputContentItem::InputText { text: message }],
            success: false,
        },
    }
}

async fn send(
    node: Arc<MeshNode>,
    permissions: PermissionMode,
    arguments: Value,
) -> Result<String, String> {
    let args: unieai_tools::SendPeerMessageArgs =
        serde_json::from_value(arguments).map_err(|err| format!("invalid arguments: {err}"))?;
    if args.message.trim().is_empty() {
        return Err("`message` must not be empty".to_string());
    }
    let peer = node
        .resolve(&PeerSelector::new(args.target))
        .await
        .map_err(|err| err.to_string())?;
    // Same relay rule as the codex engine: one hop further than the furthest
    // peer message received since this session's user last spoke.
    let hop = node.outbound_hop();
    let ack = node
        .send_message(
            &peer,
            &args.message,
            !args.queue_only,
            hop,
            Some(permissions),
        )
        .await
        .map_err(|err| err.to_string())?;
    serde_json::to_string(&unieai_tools::SendPeerMessageResult::from(ack))
        .map_err(|err| err.to_string())
}

#[cfg(test)]
#[path = "unieai_mesh_tests.rs"]
mod unieai_mesh_tests;
