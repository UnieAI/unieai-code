// Copyright (c) 2026 UnieAI. All rights reserved.
//! The model-facing `list_peers` / `send_peer_message` tools, engine-neutral.
//!
//! The codex engine offers these as core function tools; the uac engine gets
//! them as `codex_tui` dynamic tools answered by the TUI. Both use the names,
//! descriptions, argument shapes, and result shapes defined here, so a model
//! sees the same tools whichever engine it runs on.

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::identity::PeerHandle;
use crate::identity::short_ref_display_len;
use crate::wire::Ack;

pub const LIST_PEERS_TOOL: &str = "list_peers";
pub const SEND_PEER_MESSAGE_TOOL: &str = "send_peer_message";

pub const LIST_PEERS_DESCRIPTION: &str = "List other UnieAI Code sessions running on this \
machine that are reachable right now. Each peer is returned with a handle of the form \
`name [ref]`; pass that handle verbatim to send_peer_message. Peers are separate sessions owned \
by their own users - they are not your sub-agents, you cannot interrupt them, and they may \
decline your messages.";

pub const SEND_PEER_MESSAGE_DESCRIPTION: &str = "Send a message to another UnieAI Code session \
on this machine. If that session is idle it starts a turn to handle the message; if it is busy \
the message is taken into its running turn at the next step (after its current tool call or \
model response). If the peer runs with broader permissions than you, the message is held until \
its user approves it, and you get a notice when they decide. The result reports what actually \
happened (`started_turn`, `queued`, `held`, or `rejected`) - do not assume a turn started. The \
peer may also refuse or rate-limit the message, and a long automatic back-and-forth is cut off \
until a user takes part.";

pub const TARGET_DESCRIPTION: &str = "Peer handle exactly as returned by list_peers, for example \
`api [k2f8]`. A bare name is accepted only when it matches exactly one peer; if it matches \
several the call fails and lists the candidates, because guessing would start a turn in the \
wrong session.";

pub const MESSAGE_DESCRIPTION: &str = "Message text to deliver to the peer session.";

pub const QUEUE_ONLY_DESCRIPTION: &str = "When true, the message never starts a turn: an idle \
peer reads it at the start of its next turn. Defaults to false.";

/// A peer as the model sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListedPeer {
    /// The exact string to pass back as `target`.
    pub handle: String,
    pub status: String,
    pub cwd: String,
}

/// `list_peers` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListPeersResult {
    pub peers: Vec<ListedPeer>,
}

/// Renders peers with one short-ref width for the whole listing, so the
/// handle read from one row is the handle that resolves for any row.
pub fn listed_peers(peers: &[PeerHandle]) -> Vec<ListedPeer> {
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

/// `send_peer_message` arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SendPeerMessageArgs {
    pub target: String,
    pub message: String,
    #[serde(default)]
    pub queue_only: bool,
}

/// `send_peer_message` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SendPeerMessageResult {
    pub accepted: bool,
    /// `started_turn`, `queued`, `held`, or `rejected`.
    pub delivery: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl From<Ack> for SendPeerMessageResult {
    fn from(ack: Ack) -> Self {
        Self {
            accepted: ack.accepted,
            // Reported verbatim: telling the model a turn started when the
            // peer merely queued the message is the failure this design exists
            // to avoid.
            delivery: ack.delivery.as_str().to_string(),
            note: ack.reject_reason,
        }
    }
}

/// JSON Schema of `list_peers`' arguments.
pub fn list_peers_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {},
    })
}

/// JSON Schema of `send_peer_message`'s arguments.
pub fn send_peer_message_input_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "target": {"type": "string", "description": TARGET_DESCRIPTION},
            "message": {"type": "string", "description": MESSAGE_DESCRIPTION},
            "queue_only": {"type": "boolean", "description": QUEUE_ONLY_DESCRIPTION},
        },
        "required": ["target", "message"],
    })
}

#[cfg(test)]
#[path = "unieai_tools_tests.rs"]
mod unieai_tools_tests;
