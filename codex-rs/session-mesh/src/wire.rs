//! The doorbell protocol: newline-delimited JSON over a Unix socket.
//!
//! Deliberately *not* the JSON-RPC-over-WebSocket stack the app server uses.
//! Two reasons, either sufficient on its own:
//!
//! 1. **This wire is the trust perimeter.** The app-server request enum has
//!    hundreds of variants including thread forking and command execution;
//!    exposing it on a socket another process can reach makes the perimeter
//!    "everything the app server can do", and every future variant widens it
//!    silently. Six operations is a perimeter that fits in your head.
//! 2. **Version skew is the expected steady state here**, not an edge case —
//!    two terminals can easily be running different builds. The app-server
//!    client maps a deserialization failure to "drop the message", with no
//!    error on either side. That is tolerable when both ends ship from one
//!    build and disqualifying when they do not.
//!
//! Message bodies are not on the wire at all: a doorbell names a row in the
//! shared database. That keeps the format small enough to be hard to get wrong
//! and leaves a durable record when delivery fails.

use serde::Deserialize;
use serde::Serialize;

use crate::identity::PeerStatus;

/// One newline-delimited frame.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    /// Negotiated protocol version. Present on every frame so a mis-negotiated
    /// connection is visible in a packet capture, not just in a log.
    pub v: u32,
    #[serde(flatten)]
    pub body: Body,
}

/// Operations a peer may perform.
///
/// Unknown *fields* are ignored so a newer peer can add data without breaking
/// an older one. Unknown *operations* land in [`Body::Unknown`] and are refused
/// out loud. The asymmetry is the point: additive data must be ignorable,
/// additive behaviour must never be silently swallowed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Body {
    Hello(Hello),
    HelloOk(HelloOk),
    Doorbell(Doorbell),
    Ack(Ack),
    Probe,
    ProbeOk(ProbeOk),
    Error(WireError),
    #[serde(other)]
    Unknown,
}

/// Opens every connection. There is no optimistic send: a peer that cannot
/// agree on a version finds out before it has done anything.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub v_min: u32,
    pub v_max: u32,
    pub from_thread_id: String,
    pub cli_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelloOk {
    pub v_chosen: u32,
    pub cli_version: String,
}

/// "A message with this id is waiting for you in the database."
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Doorbell {
    pub message_id: String,
    pub from_thread_id: String,
}

/// What the recipient did with the message.
///
/// Always sent, never fire-and-forget: a tool that reports "sent" when the peer
/// was busy, rate-limited, or refused would recreate exactly the invisible
/// failure this protocol exists to avoid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ack {
    pub accepted: bool,
    pub delivery: Delivery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reject_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// The recipient was idle and a turn is now running.
    StartedTurn,
    /// The recipient was busy; the message waits for the next turn boundary.
    Queued,
    /// The recipient declined.
    Rejected,
}

impl Delivery {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartedTurn => "started_turn",
            Self::Queued => "queued",
            Self::Rejected => "rejected",
        }
    }
}

/// A liveness probe's answer. Doubles as the status shown in a peer listing,
/// so the listing reflects the peer's own view rather than a cached guess.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeOk {
    pub status: String,
    pub cli_version: String,
}

impl ProbeOk {
    pub fn peer_status(&self) -> PeerStatus {
        match self.status.as_str() {
            "idle" => PeerStatus::Idle,
            "working" => PeerStatus::Working,
            _ => PeerStatus::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
    /// Set on `VersionUnsupported` so the caller can report both ends' ranges
    /// instead of a bare failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v_min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v_max: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    VersionUnsupported,
    UnsupportedOp,
    RateLimited,
    TooLarge,
    HopLimit,
    Busy,
    NotFound,
    Internal,
    /// A code this build does not know. Keeps an older peer able to *report* a
    /// newer peer's refusal instead of failing to parse it.
    #[serde(other)]
    Unknown,
}

impl Envelope {
    pub fn new(v: u32, body: Body) -> Self {
        Self { v, body }
    }

    /// Serializes to a single line, newline included.
    pub fn to_line(&self) -> Result<String, serde_json::Error> {
        let mut line = serde_json::to_string(self)?;
        line.push('\n');
        Ok(line)
    }

    pub fn from_line(line: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(line.trim_end_matches(['\r', '\n']))
    }
}

/// Chooses a version both ends can speak.
pub fn negotiate_version(
    local_min: u32,
    local_max: u32,
    remote_min: u32,
    remote_max: u32,
) -> Option<u32> {
    let chosen = local_max.min(remote_max);
    (chosen >= local_min.max(remote_min)).then_some(chosen)
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod wire_tests;
