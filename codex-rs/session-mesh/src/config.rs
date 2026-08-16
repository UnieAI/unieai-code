use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use codex_protocol::ThreadId;

/// Directory under `CODEX_HOME` holding one socket per meshed session.
pub const SOCKET_DIR_NAME: &str = "session-mesh";

/// Wire protocol versions this build can speak.
///
/// Published in the registry so a picker can grey out unreachable peers before
/// the user attempts a send, rather than failing at delivery time.
pub const PROTOCOL_VERSION_MIN: u32 = 1;
pub const PROTOCOL_VERSION_MAX: u32 = 1;

/// Tunables for a mesh node.
#[derive(Debug, Clone)]
pub struct MeshConfig {
    pub codex_home: PathBuf,
    /// Largest single wire frame accepted, so a peer cannot force an unbounded
    /// allocation.
    pub max_frame_bytes: usize,
    /// Largest message body accepted.
    pub max_content_bytes: usize,
    /// Rejected once a message has been relayed this many times, which stops
    /// two sessions from ping-ponging turns at each other.
    pub max_hops: u32,
    /// Minimum gap between turn-starting deliveries from the same peer.
    /// Messages arriving faster are downgraded to queue-only, never dropped.
    pub trigger_turn_min_interval: Duration,
    /// How long a launcher waits for a child to register before giving up.
    ///
    /// Generous because the child pays full CLI startup — auth, MCP, skills —
    /// before it ever reaches the mesh.
    pub spawn_rendezvous_timeout: Duration,
    pub connect_timeout: Duration,
    pub handshake_timeout: Duration,
    pub request_timeout: Duration,
    /// Concurrent inbound connections served before new ones are refused.
    pub max_inbound_connections: usize,
}

impl MeshConfig {
    pub fn new(codex_home: impl Into<PathBuf>) -> Self {
        Self {
            codex_home: codex_home.into(),
            max_frame_bytes: 256 * 1024,
            max_content_bytes: 64 * 1024,
            max_hops: 3,
            trigger_turn_min_interval: Duration::from_secs(10),
            spawn_rendezvous_timeout: Duration::from_secs(45),
            connect_timeout: Duration::from_secs(2),
            handshake_timeout: Duration::from_secs(2),
            request_timeout: Duration::from_secs(5),
            max_inbound_connections: 8,
        }
    }

    /// Directory holding every session socket. Created 0700.
    pub fn socket_dir(&self) -> PathBuf {
        self.codex_home.join(SOCKET_DIR_NAME)
    }

    /// Socket path for `thread_id`.
    pub fn socket_path(&self, thread_id: ThreadId) -> PathBuf {
        self.socket_dir().join(format!("{thread_id}.sock"))
    }

    /// Where a detached child's output is kept.
    ///
    /// A detached child has no terminal, so without this its output would go
    /// nowhere and a failure to start would be invisible.
    pub fn child_log_dir(&self) -> PathBuf {
        self.socket_dir().join("logs")
    }

    /// Advisory lock guarding the probe-then-unlink reclaim of a socket path.
    ///
    /// `ThreadId` is stable across resume, so two processes resuming the same
    /// thread contend for one path; the reclaim probe alone has a window where
    /// both decide it is stale.
    pub fn socket_lock_path(&self, thread_id: ThreadId) -> PathBuf {
        self.socket_dir().join(format!("{thread_id}.sock.lock"))
    }
}

/// Extracts the `ThreadId` a socket path belongs to, if it is one of ours.
pub fn thread_id_from_socket_path(path: &Path) -> Option<ThreadId> {
    let file_name = path.file_name()?.to_str()?;
    let stem = file_name.strip_suffix(".sock")?;
    ThreadId::from_string(stem).ok()
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod config_tests;
