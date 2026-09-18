//! TUI surfaces for the machine-local session mesh.
//!
//! The TUI reads the shared state database directly rather than going through
//! the app server. That is deliberate: the mesh adds no protocol shapes, so it
//! cannot fall foul of the client's habit of dropping messages it fails to
//! deserialize, and the transcript, unread count, and peer list all come from
//! one query instead of three round trips.
//!
//! The cost is that it only works when the app server is local, which
//! [`peer_bus_available`] enforces — a TUI driving a remote core would
//! otherwise confidently list this laptop's peers as if they were the remote
//! host's.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use codex_protocol::ThreadId;
use codex_state::SESSION_MESH_DELIVERY_APPROVED;
use codex_state::SESSION_MESH_DELIVERY_DELIVERING;
use codex_state::SESSION_MESH_DELIVERY_DENIED;
use codex_state::SESSION_MESH_DELIVERY_HELD;
use codex_state::SessionMeshMessageRecord;
use ratatui::style::Stylize;
use ratatui::text::Line;
use unieai_session_mesh::short_ref_display_len;

use crate::AppServerTarget;
use crate::history_cell::HistoryCell;
use crate::history_cell::plain_lines;

/// How often the inbox and peer list are refreshed.
///
/// Fast enough that a message feels immediate, slow enough that a dozen idle
/// sessions are not a load source. There is no push channel here on purpose:
/// the delivery path already woke the session, so this poll only drives what
/// the user sees.
pub(crate) const PEER_BUS_POLL_INTERVAL: Duration = Duration::from_millis(750);

/// A peer as the TUI renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PeerRow {
    pub(crate) thread_id: ThreadId,
    /// `name [ref]`, ready to display and to type back.
    pub(crate) handle: String,
    pub(crate) status: String,
    pub(crate) cwd: PathBuf,
}

/// Why the peer surfaces are unavailable, when they are.
///
/// Distinct from "no peers": an empty list and a broken mesh must never look
/// the same, or a user cannot tell a quiet machine from a misconfigured one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PeerBusUnavailable {
    FeatureDisabled,
    NoStateDatabase,
    RemoteAppServer,
}

impl PeerBusUnavailable {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::FeatureDisabled => {
                "Session mesh is off. Enable `session_mesh` under `[features]` to reach other \
sessions on this machine."
            }
            Self::NoStateDatabase => {
                "Session mesh is unavailable: this host has no local state database."
            }
            Self::RemoteAppServer => {
                "Session mesh is unavailable while driving a remote app server; peers are local to \
the machine running the sessions."
            }
        }
    }
}

/// Decides whether the peer surfaces can work at all in this TUI.
pub(crate) fn peer_bus_available(
    feature_enabled: bool,
    has_state_db: bool,
    target: &AppServerTarget,
) -> Result<(), PeerBusUnavailable> {
    if !feature_enabled {
        return Err(PeerBusUnavailable::FeatureDisabled);
    }
    if matches!(target, AppServerTarget::Remote { .. }) {
        return Err(PeerBusUnavailable::RemoteAppServer);
    }
    if !has_state_db {
        return Err(PeerBusUnavailable::NoStateDatabase);
    }
    Ok(())
}

/// Wall-clock milliseconds, used as the inbox watermark.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// Builds display rows from registry records, dropping peers whose process is
/// provably gone.
///
/// The socket probe the mesh uses is deliberately skipped — the TUI refreshes on
/// a timer and a fan of connections per tick would be a poor trade for a display
/// refresh. The pid check is not skipped: it is one `/proc` read, and without it
/// a session killed without cleanup keeps appearing in the panel as though it
/// were reachable, which is worse than showing nothing.
pub(crate) async fn live_rows_from_records(
    records: &[codex_state::SessionMeshPeerWithName],
) -> Vec<PeerRow> {
    let mut live = Vec::with_capacity(records.len());
    for record in records {
        let identity = unieai_utils_process_liveness::ProcessIdentity {
            pid: record.peer.pid,
            start_token: record.peer.process_start_token.clone(),
            boot_id: record.peer.boot_id.clone(),
        };
        if identity.is_possibly_alive().await {
            live.push(record.clone());
        }
    }
    rows_from_records(&live)
}

/// Builds display rows straight from registry records, without any liveness
/// filtering. Callers that have not already filtered should prefer
/// [`live_rows_from_records`].
pub(crate) fn rows_from_records(records: &[codex_state::SessionMeshPeerWithName]) -> Vec<PeerRow> {
    let handles: Vec<unieai_session_mesh::PeerHandle> = records
        .iter()
        .map(|record| unieai_session_mesh::PeerHandle {
            thread_id: record.peer.thread_id,
            short_ref: record.peer.short_ref.clone(),
            display_name: record.display_name.clone(),
            cwd: PathBuf::from(record.peer.cwd.clone()),
            status: unieai_session_mesh::PeerStatus::Unknown,
        })
        .collect();
    peer_rows(&handles)
}

/// Builds display rows, choosing one short-ref width for the whole listing so
/// the handle a user reads in one row is the handle they can type for any row.
pub(crate) fn peer_rows(peers: &[unieai_session_mesh::PeerHandle]) -> Vec<PeerRow> {
    let width = short_ref_display_len(peers);
    peers
        .iter()
        .map(|peer| PeerRow {
            thread_id: peer.thread_id,
            handle: peer.display_handle(width),
            status: peer.status.as_str().to_string(),
            cwd: peer.cwd.clone(),
        })
        .collect()
}

/// Drops `thread_id` (this session) from a listing.
pub(crate) fn exclude_thread(rows: Vec<PeerRow>, thread_id: Option<ThreadId>) -> Vec<PeerRow> {
    rows.into_iter()
        .filter(|row| Some(row.thread_id) != thread_id)
        .collect()
}

/// Decides which stored messages are new to the user.
///
/// A message is shown once, when its delivery has settled (delivered,
/// queued, held, refused) — not while a doorbell is still deciding, which is
/// what would otherwise show a card for a message that is about to be held.
/// Anything created or delivered since `since_ms` counts, which also covers
/// messages left while this session was not running and picked up at start.
#[derive(Debug)]
pub(crate) struct PeerFeed {
    since_ms: i64,
    seen: HashSet<String>,
}

impl PeerFeed {
    pub(crate) fn new(since_ms: i64) -> Self {
        Self {
            since_ms,
            seen: HashSet::new(),
        }
    }

    pub(crate) fn take_new(
        &mut self,
        messages: Vec<SessionMeshMessageRecord>,
    ) -> Vec<SessionMeshMessageRecord> {
        messages
            .into_iter()
            .filter(|message| {
                let Some(delivery) = message.delivery.as_deref() else {
                    return false;
                };
                let settled = !matches!(
                    delivery,
                    SESSION_MESH_DELIVERY_DELIVERING | SESSION_MESH_DELIVERY_APPROVED
                );
                let recent = message.created_at_ms >= self.since_ms
                    || message
                        .delivered_at_ms
                        .is_some_and(|delivered| delivered >= self.since_ms)
                    || delivery == SESSION_MESH_DELIVERY_HELD;
                settled && recent && self.seen.insert(message.message_id.clone())
            })
            .collect()
    }
}

/// A message received from another session, rendered into the transcript.
///
/// Peer messages are always shown. A message that can start a turn must never
/// be invisible, or the user cannot account for work their session did.
#[derive(Debug)]
pub(crate) struct PeerMessageCell {
    from_handle: String,
    body: String,
    /// `peer message`, `delivery notice`, or a held/refused variant.
    label: String,
}

impl PeerMessageCell {
    #[cfg(test)]
    pub(crate) fn new(from_handle: String, body: String) -> Self {
        Self {
            from_handle,
            body,
            label: "peer message".to_string(),
        }
    }

    pub(crate) fn from_record(from_handle: String, message: &SessionMeshMessageRecord) -> Self {
        let notice = unieai_session_mesh::MessageKind::parse(&message.kind)
            == unieai_session_mesh::MessageKind::Notice;
        let label = match message.delivery.as_deref() {
            _ if notice => "delivery notice".to_string(),
            Some(SESSION_MESH_DELIVERY_HELD) => {
                "peer message (held - awaiting your approval)".to_string()
            }
            Some(SESSION_MESH_DELIVERY_DENIED) => "peer message (denied)".to_string(),
            Some(delivery)
                if delivery.starts_with("rejected") || delivery.starts_with("failed") =>
            {
                "peer message (refused)".to_string()
            }
            _ => "peer message".to_string(),
        };
        Self {
            from_handle,
            body: message.content.clone(),
            label,
        }
    }
}

impl HistoryCell for PeerMessageCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = vec![
            vec![
                self.label.clone().magenta(),
                " from ".dim(),
                self.from_handle.clone().bold(),
            ]
            .into(),
            "".into(),
        ];
        lines.extend(self.body.lines().map(|line| line.to_string().into()));
        lines
    }

    fn raw_lines(&self) -> Vec<Line<'static>> {
        plain_lines(self.display_lines(u16::MAX))
    }
}

/// Renders the sender of `message` as a handle, falling back to its short ref
/// when the peer is no longer listed.
pub(crate) fn sender_handle(message: &SessionMeshMessageRecord, peers: &[PeerRow]) -> String {
    peers
        .iter()
        .find(|peer| peer.thread_id == message.from_thread_id)
        .map(|peer| peer.handle.clone())
        .unwrap_or_else(|| unieai_session_mesh::short_ref_for(message.from_thread_id))
}

#[cfg(test)]
#[path = "peers_tests.rs"]
mod peers_tests;
