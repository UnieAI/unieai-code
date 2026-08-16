-- Parentage for detached child sessions.
--
-- A child's thread id does not exist until the child creates its own session,
-- so the parent cannot address it at launch. It instead mints a `spawn_id`,
-- passes that to the child, and looks it up here once the child registers —
-- a rendezvous, rather than threading a preallocated thread id through session
-- construction.

ALTER TABLE session_mesh_peers ADD COLUMN spawn_id TEXT;
ALTER TABLE session_mesh_peers ADD COLUMN spawned_by_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_mesh_peers_spawn_id
    ON session_mesh_peers (spawn_id);
