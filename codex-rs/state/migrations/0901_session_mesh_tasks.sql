-- Work that any meshed session on this machine can pick up.
--
-- Fork-local migration; see 0900 for why the numbering starts at 0900.

CREATE TABLE IF NOT EXISTS session_mesh_tasks (
    task_id TEXT PRIMARY KEY,
    queue TEXT NOT NULL DEFAULT 'default',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    -- pending | claimed | done | failed | cancelled
    status TEXT NOT NULL,
    created_by_thread_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    -- NULL means anyone may claim it.
    assigned_to_thread_id TEXT,
    claimed_by_thread_id TEXT,
    -- Server-side only, never handed to a model: a report carrying a stale
    -- token affects zero rows instead of overwriting the work of whoever
    -- reclaimed the task.
    claim_token TEXT,
    claimed_at_ms INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    result_json TEXT,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL
);

-- Ordered exactly as the claim query reads them, so a claim is an index scan
-- rather than a sort.
CREATE INDEX IF NOT EXISTS idx_session_mesh_tasks_claimable
    ON session_mesh_tasks (queue, status, priority DESC, created_at_ms);

CREATE INDEX IF NOT EXISTS idx_session_mesh_tasks_assigned
    ON session_mesh_tasks (assigned_to_thread_id, status);

CREATE INDEX IF NOT EXISTS idx_session_mesh_tasks_claimed
    ON session_mesh_tasks (claimed_by_thread_id, status);
