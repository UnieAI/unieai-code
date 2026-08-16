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

use std::path::PathBuf;
use std::time::Duration;

use codex_protocol::ThreadId;
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

/// A message received from another session, rendered into the transcript.
///
/// Peer messages are always shown. A message that can start a turn must never
/// be invisible, or the user cannot account for work their session did.
#[derive(Debug)]
pub(crate) struct PeerMessageCell {
    from_handle: String,
    body: String,
}

impl PeerMessageCell {
    pub(crate) fn new(from_handle: String, body: String) -> Self {
        Self { from_handle, body }
    }
}

impl HistoryCell for PeerMessageCell {
    fn display_lines(&self, _width: u16) -> Vec<Line<'static>> {
        let mut lines: Vec<Line<'static>> = vec![
            vec![
                "peer message".magenta(),
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
