//! What the mesh hands to the session that owns it.
//!
//! The mesh knows nothing about sessions, turns, or mailboxes. It resolves who
//! is calling, enforces the limits, and then calls back through this trait —
//! which the core crate implements by doing exactly what an in-process
//! sub-agent message already does. That inversion is what keeps the socket
//! logic testable without a model client.

use std::future::Future;
use std::pin::Pin;

use crate::identity::PeerHandle;
use crate::wire::Delivery;

pub type InboundFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A message that has passed every check and is ready to deliver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundMessage {
    pub message_id: String,
    pub content: String,
    /// Whether the sender asked for a turn to start rather than merely queuing.
    /// Honouring it is still the recipient's decision.
    pub trigger_turn: bool,
    pub hop: u32,
}

/// The recipient's answer, reported back to the sender verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundDecision {
    Accepted { delivery: Delivery },
    Rejected { reason: String },
}

/// A snapshot of the local session, used to answer probes and to fill in the
/// status column of a peer listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSnapshot {
    /// `idle`, `working`, or anything else, which reads as unknown.
    pub status: String,
    pub cli_version: String,
}

/// Implemented by whatever owns the session on the receiving end.
pub trait MeshInbound: Send + Sync {
    /// Delivers a message. The returned decision is what the sender is told,
    /// so it must describe what actually happened, not what was intended.
    fn on_message<'a>(
        &'a self,
        from: PeerHandle,
        message: InboundMessage,
    ) -> InboundFuture<'a, InboundDecision>;

    /// Answers a liveness probe.
    fn on_probe(&self) -> InboundFuture<'_, LocalSnapshot>;
}
