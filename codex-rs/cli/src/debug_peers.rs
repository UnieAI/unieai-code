//! `unieai debug peers` — inspect and exercise the machine-local session mesh.
//!
//! This exists so the mesh can be proven end to end without a TUI: two
//! terminals, one command, and a session that visibly starts a turn. It joins
//! the mesh as a short-lived member rather than reading the registry directly,
//! because the registry alone cannot tell you who is *reachable* — only a
//! probe can, and probing is what the real callers do.

use std::path::PathBuf;
use std::sync::Arc;

use codex_core::config::ConfigBuilder;
use codex_protocol::ThreadId;
use unieai_session_mesh::InboundDecision;
use unieai_session_mesh::InboundFuture;
use unieai_session_mesh::InboundMessage;
use unieai_session_mesh::LocalSessionIdentity;
use unieai_session_mesh::LocalSnapshot;
use unieai_session_mesh::MeshConfig;
use unieai_session_mesh::MeshInbound;
use unieai_session_mesh::MeshNode;
use unieai_session_mesh::MeshStore;
use unieai_session_mesh::PeerHandle;
use unieai_session_mesh::PeerSelector;
use unieai_session_mesh::StateRuntimeStore;
use unieai_session_mesh::short_ref_display_len;
use codex_utils_cli::CliConfigOverrides;

#[derive(Debug, clap::Parser)]
pub struct DebugPeersCommand {
    #[command(subcommand)]
    subcommand: DebugPeersSubcommand,
}

#[derive(Debug, clap::Subcommand)]
enum DebugPeersSubcommand {
    /// List reachable sessions on this machine.
    List,

    /// Send a message to another session, starting a turn there.
    Send(DebugPeersSendCommand),

    /// Ask one session what it is doing right now.
    Probe(DebugPeersProbeCommand),

    /// Join the mesh and stay reachable, printing messages as they arrive.
    ///
    /// Stands in for a real session when proving cross-process delivery: it
    /// exercises the same listener, handshake, and limit checks a session does,
    /// without needing a model or credentials.
    Serve(DebugPeersServeCommand),
}

#[derive(Debug, clap::Parser)]
struct DebugPeersServeCommand {
    /// Stop after this many seconds.
    #[arg(long, default_value_t = 60)]
    seconds: u64,
}

#[derive(Debug, clap::Parser)]
struct DebugPeersSendCommand {
    /// Peer selector, for example `api [k2f8]` or a full thread id.
    #[arg(value_name = "TARGET")]
    target: String,

    /// Message body.
    #[arg(value_name = "MESSAGE")]
    message: String,

    /// Queue the message instead of letting it start a turn.
    #[arg(long)]
    queue_only: bool,
}

#[derive(Debug, clap::Parser)]
struct DebugPeersProbeCommand {
    #[arg(value_name = "TARGET")]
    target: String,
}

/// A mesh member that exists only for the duration of one command.
///
/// It answers probes so it looks like any other member, and refuses messages
/// because there is no session behind it to deliver them to.
struct EphemeralInbound;

impl MeshInbound for EphemeralInbound {
    fn on_message<'a>(
        &'a self,
        _from: PeerHandle,
        _message: InboundMessage,
    ) -> InboundFuture<'a, InboundDecision> {
        Box::pin(async move {
            InboundDecision::Rejected {
                reason: "this is a short-lived debug client, not a session".to_string(),
            }
        })
    }

    fn on_probe(&self) -> InboundFuture<'_, LocalSnapshot> {
        Box::pin(async move {
            LocalSnapshot {
                status: "debug".to_string(),
                cli_version: env!("CARGO_PKG_VERSION").to_string(),
            }
        })
    }
}

/// A mesh member that accepts messages and prints them.
struct ServingInbound;

impl MeshInbound for ServingInbound {
    fn on_message<'a>(
        &'a self,
        from: PeerHandle,
        message: InboundMessage,
    ) -> InboundFuture<'a, InboundDecision> {
        Box::pin(async move {
            println!(
                "received from {} (trigger_turn={}, hop={}): {}",
                from.short_ref, message.trigger_turn, message.hop, message.content
            );
            // Reports StartedTurn when asked to, mirroring what an idle session
            // does, so the sender's ack path is exercised for real.
            InboundDecision::Accepted {
                delivery: if message.trigger_turn {
                    unieai_session_mesh::wire::Delivery::StartedTurn
                } else {
                    unieai_session_mesh::wire::Delivery::Queued
                },
            }
        })
    }

    fn on_probe(&self) -> InboundFuture<'_, LocalSnapshot> {
        Box::pin(async move {
            LocalSnapshot {
                status: "idle".to_string(),
                cli_version: env!("CARGO_PKG_VERSION").to_string(),
            }
        })
    }
}

pub async fn run_debug_peers_command(
    command: DebugPeersCommand,
    config_overrides: CliConfigOverrides,
) -> anyhow::Result<()> {
    let cli_overrides = config_overrides
        .parse_overrides()
        .map_err(anyhow::Error::msg)?;
    let config = ConfigBuilder::default()
        .cli_overrides(cli_overrides)
        .build()
        .await?;

    let Some(state_db) = codex_core::init_state_db(&config).await else {
        anyhow::bail!("session mesh is unavailable: local state database is not initialized");
    };

    let node = MeshNode::join(
        MeshConfig::new(config.codex_home.clone()),
        LocalSessionIdentity {
            // A thread id nobody else will resume, so this client never
            // contends with a real session for a socket path.
            thread_id: ThreadId::new(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            session_source: "debug".to_string(),
            cli_version: env!("CARGO_PKG_VERSION").to_string(),
            spawn_id: None,
            spawned_by: None,
        },
        Arc::new(StateRuntimeStore::new(state_db)) as Arc<dyn MeshStore>,
        if matches!(command.subcommand, DebugPeersSubcommand::Serve(_)) {
            Arc::new(ServingInbound) as Arc<dyn MeshInbound>
        } else {
            Arc::new(EphemeralInbound) as Arc<dyn MeshInbound>
        },
    )
    .await?;

    let result = dispatch(&node, command.subcommand).await;
    // Always withdraw, or the next `list` will spend a probe discovering that
    // this process is gone.
    node.leave().await;
    result
}

async fn dispatch(node: &MeshNode, subcommand: DebugPeersSubcommand) -> anyhow::Result<()> {
    match subcommand {
        DebugPeersSubcommand::List => {
            let peers = node.list_peers().await?;
            if peers.is_empty() {
                println!("no reachable sessions (this is not an error)");
                return Ok(());
            }
            let width = short_ref_display_len(&peers);
            for peer in &peers {
                println!(
                    "{}  {}  {}",
                    peer.display_handle(width),
                    peer.status.as_str(),
                    peer.cwd.display()
                );
            }
        }
        DebugPeersSubcommand::Send(cmd) => {
            let peer = node.resolve(&PeerSelector::new(cmd.target)).await?;
            let ack = node
                .send_message(&peer, &cmd.message, !cmd.queue_only, /*hop*/ 0)
                .await?;
            println!(
                "accepted={} delivery={}{}",
                ack.accepted,
                ack.delivery.as_str(),
                ack.reject_reason
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            );
        }
        DebugPeersSubcommand::Serve(cmd) => {
            println!(
                "serving as {} at {}",
                unieai_session_mesh::short_ref_for(node.thread_id()),
                node.thread_id()
            );
            tokio::time::sleep(std::time::Duration::from_secs(cmd.seconds)).await;
        }
        DebugPeersSubcommand::Probe(cmd) => {
            let peer = node.resolve(&PeerSelector::new(cmd.target)).await?;
            println!(
                "{}  {}",
                peer.display_handle(unieai_session_mesh::SHORT_REF_MIN_LEN),
                peer.status.as_str()
            );
        }
    }
    Ok(())
}
