-- Copyright (c) 2026 UnieAI. All rights reserved.
-- Delivery bookkeeping for the session mesh.
--
-- `kind` separates a peer's message from a notice the mesh writes about an
-- earlier message (held, approved, denied); a notice never starts a turn and
-- is never held.
--
-- The sender stamps its engine and permission mode on every message. The
-- recipient compares that mode with its own: a message that would let a
-- more-restricted session act through a less-restricted one is held until the
-- recipient's user approves it (delivery = 'held', then 'approved' or
-- 'denied').
ALTER TABLE session_mesh_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE session_mesh_messages ADD COLUMN sender_engine TEXT;
ALTER TABLE session_mesh_messages ADD COLUMN sender_sandbox TEXT;
ALTER TABLE session_mesh_messages ADD COLUMN sender_approval TEXT;

-- Startup pickup and retention both scan by recipient and delivery state.
CREATE INDEX IF NOT EXISTS idx_session_mesh_messages_pending
    ON session_mesh_messages (to_thread_id, delivered_at_ms, delivery);
CREATE INDEX IF NOT EXISTS idx_session_mesh_messages_created
    ON session_mesh_messages (created_at_ms);
