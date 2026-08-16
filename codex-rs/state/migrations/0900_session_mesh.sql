-- Machine-local session mesh: which CLI sessions are reachable, and the
-- messages waiting for them.
--
-- Fork-local migrations start at 0900 on purpose. Upstream Codex numbers its
-- own migrations sequentially from the 00xx range, so reusing that range would
-- make an upstream migration collide with a fork one after a rebase, and the
-- checksum validation would then fail on every existing user database. sqlx
-- orders by version and tolerates gaps, so the jump costs nothing.

-- One row per live meshed session. Rows are inserted at join and deleted at
-- leave; there is no heartbeat column because liveness is decided by connecting
-- to the socket, not by comparing timestamps.
CREATE TABLE IF NOT EXISTS session_mesh_peers (
    thread_id TEXT PRIMARY KEY,
    -- Deliberately not UNIQUE: two thread ids can share a short ref, and that
    -- must surface as an ambiguous selector, never as a failed insert that
    -- silently keeps a session off the mesh.
    short_ref TEXT NOT NULL,
    pid INTEGER NOT NULL,
    -- Changes when the OS recycles the pid, so a stale row naming a live but
    -- unrelated process is detectable.
    process_start_token TEXT NOT NULL,
    -- Start tokens are only comparable within one boot.
    boot_id TEXT NOT NULL,
    socket_path TEXT NOT NULL,
    cwd TEXT NOT NULL,
    session_source TEXT NOT NULL,
    cli_version TEXT NOT NULL,
    -- Wire versions this peer speaks, so a picker can grey out an unreachable
    -- peer before a send is attempted rather than after it fails.
    protocol_min INTEGER NOT NULL,
    protocol_max INTEGER NOT NULL,
    joined_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_mesh_peers_short_ref
    ON session_mesh_peers (short_ref);

-- Message bodies live here rather than on the wire. The socket carries only a
-- doorbell naming this row, which keeps the wire format small enough that
-- version skew between two differently-versioned CLIs is hard to get wrong, and
-- leaves a durable record when delivery fails.
CREATE TABLE IF NOT EXISTS session_mesh_messages (
    message_id TEXT PRIMARY KEY,
    from_thread_id TEXT NOT NULL,
    to_thread_id TEXT NOT NULL,
    content TEXT NOT NULL,
    -- Counts relays so two sessions cannot ping-pong turns at each other
    -- unattended.
    hop INTEGER NOT NULL DEFAULT 0,
    trigger_turn INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    delivered_at_ms INTEGER,
    -- NULL until delivery is attempted, then started_turn | queued | rejected:<reason>.
    delivery TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_mesh_messages_to
    ON session_mesh_messages (to_thread_id, created_at_ms);
