//! Registry and mailbox rows for the machine-local session mesh.
//!
//! The socket layer decides who is *reachable*; this module only stores who
//! *claims* to be, plus the message bodies the socket layer refers to by id.
//! Keeping bodies here rather than on the wire means a message survives a failed
//! delivery and the TUI can render it without a protocol round trip.

use super::*;

/// A session's published registry row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeshPeerRecord {
    pub thread_id: ThreadId,
    pub short_ref: String,
    pub pid: u32,
    pub process_start_token: String,
    pub boot_id: String,
    pub socket_path: String,
    pub cwd: String,
    pub session_source: String,
    pub cli_version: String,
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub joined_at_ms: i64,
    /// Set on a session launched by another one, so the launcher can find it
    /// before it knows the child's thread id.
    pub spawn_id: Option<String>,
    pub spawned_by_thread_id: Option<ThreadId>,
}

/// A registry row joined with the human-chosen name from `threads`.
///
/// The name is deliberately not stored on the peer row: `/rename` already owns
/// `threads.name`, so joining keeps one writer and removes any chance of the
/// two drifting apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeshPeerWithName {
    pub peer: SessionMeshPeerRecord,
    pub display_name: Option<String>,
}

/// A message waiting for, or already delivered to, a peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeshMessageRecord {
    pub message_id: String,
    pub from_thread_id: ThreadId,
    pub to_thread_id: ThreadId,
    pub content: String,
    pub hop: u32,
    pub trigger_turn: bool,
    pub created_at_ms: i64,
    pub delivered_at_ms: Option<i64>,
    pub delivery: Option<String>,
}

impl StateRuntime {
    /// Publishes or refreshes this session's registry row.
    pub async fn upsert_session_mesh_peer(
        &self,
        peer: &SessionMeshPeerRecord,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"
INSERT INTO session_mesh_peers (
    thread_id, short_ref, pid, process_start_token, boot_id, socket_path, cwd,
    session_source, cli_version, protocol_min, protocol_max, joined_at_ms,
    spawn_id, spawned_by_thread_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET
    short_ref = excluded.short_ref,
    pid = excluded.pid,
    process_start_token = excluded.process_start_token,
    boot_id = excluded.boot_id,
    socket_path = excluded.socket_path,
    cwd = excluded.cwd,
    session_source = excluded.session_source,
    cli_version = excluded.cli_version,
    protocol_min = excluded.protocol_min,
    protocol_max = excluded.protocol_max,
    joined_at_ms = excluded.joined_at_ms,
    spawn_id = excluded.spawn_id,
    spawned_by_thread_id = excluded.spawned_by_thread_id
            "#,
        )
        .bind(peer.thread_id.to_string())
        .bind(&peer.short_ref)
        .bind(i64::from(peer.pid))
        .bind(&peer.process_start_token)
        .bind(&peer.boot_id)
        .bind(&peer.socket_path)
        .bind(&peer.cwd)
        .bind(&peer.session_source)
        .bind(&peer.cli_version)
        .bind(i64::from(peer.protocol_min))
        .bind(i64::from(peer.protocol_max))
        .bind(peer.joined_at_ms)
        .bind(peer.spawn_id.as_deref())
        .bind(peer.spawned_by_thread_id.map(|id| id.to_string()))
        .execute(self.pool.as_ref())
        .await?;
        Ok(())
    }

    /// Withdraws a session from the mesh.
    pub async fn delete_session_mesh_peer(&self, thread_id: ThreadId) -> anyhow::Result<bool> {
        let result = sqlx::query("DELETE FROM session_mesh_peers WHERE thread_id = ?")
            .bind(thread_id.to_string())
            .execute(self.pool.as_ref())
            .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Lists every published peer, newest first, with its `/rename` name.
    ///
    /// Returns claims, not confirmations: a row here only means some process
    /// published it and did not clean up. The caller must probe before treating
    /// a peer as reachable.
    pub async fn list_session_mesh_peers(&self) -> anyhow::Result<Vec<SessionMeshPeerWithName>> {
        let rows = sqlx::query(
            r#"
SELECT p.thread_id, p.short_ref, p.pid, p.process_start_token, p.boot_id, p.socket_path,
    p.cwd, p.session_source, p.cli_version, p.protocol_min, p.protocol_max, p.joined_at_ms,
    p.spawn_id, p.spawned_by_thread_id,
    t.name AS display_name
FROM session_mesh_peers p
LEFT JOIN threads t ON t.id = p.thread_id
ORDER BY p.joined_at_ms DESC
            "#,
        )
        .fetch_all(self.pool.as_ref())
        .await?;

        rows.into_iter()
            .map(|row| {
                let thread_id: String = row.try_get("thread_id")?;
                Ok(SessionMeshPeerWithName {
                    peer: SessionMeshPeerRecord {
                        thread_id: ThreadId::from_string(&thread_id)?,
                        short_ref: row.try_get("short_ref")?,
                        pid: u32::try_from(row.try_get::<i64, _>("pid")?)?,
                        process_start_token: row.try_get("process_start_token")?,
                        boot_id: row.try_get("boot_id")?,
                        socket_path: row.try_get("socket_path")?,
                        cwd: row.try_get("cwd")?,
                        session_source: row.try_get("session_source")?,
                        cli_version: row.try_get("cli_version")?,
                        protocol_min: u32::try_from(row.try_get::<i64, _>("protocol_min")?)?,
                        protocol_max: u32::try_from(row.try_get::<i64, _>("protocol_max")?)?,
                        joined_at_ms: row.try_get("joined_at_ms")?,
                        spawn_id: row.try_get("spawn_id")?,
                        spawned_by_thread_id: row
                            .try_get::<Option<String>, _>("spawned_by_thread_id")?
                            .map(|id| ThreadId::from_string(&id))
                            .transpose()?,
                    },
                    display_name: row.try_get("display_name")?,
                })
            })
            .collect()
    }

    /// Finds the peer a launcher is waiting for.
    ///
    /// Returns `None` until the child has registered, which is the whole point:
    /// the launcher polls this rather than guessing when the child is ready.
    pub async fn find_session_mesh_peer_by_spawn_id(
        &self,
        spawn_id: &str,
    ) -> anyhow::Result<Option<ThreadId>> {
        let row = sqlx::query("SELECT thread_id FROM session_mesh_peers WHERE spawn_id = ?")
            .bind(spawn_id)
            .fetch_optional(self.pool.as_ref())
            .await?;
        row.map(|row| {
            let thread_id: String = row.try_get("thread_id")?;
            Ok(ThreadId::from_string(&thread_id)?)
        })
        .transpose()
    }

    /// Records a message before its doorbell is rung.
    ///
    /// Writing first means a delivery that fails mid-flight leaves evidence
    /// rather than vanishing.
    pub async fn enqueue_session_mesh_message(
        &self,
        message: &SessionMeshMessageRecord,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"
INSERT INTO session_mesh_messages (
    message_id, from_thread_id, to_thread_id, content, hop, trigger_turn,
    created_at_ms, delivered_at_ms, delivery
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&message.message_id)
        .bind(message.from_thread_id.to_string())
        .bind(message.to_thread_id.to_string())
        .bind(&message.content)
        .bind(i64::from(message.hop))
        .bind(i64::from(message.trigger_turn))
        .bind(message.created_at_ms)
        .bind(message.delivered_at_ms)
        .bind(message.delivery.as_deref())
        .execute(self.pool.as_ref())
        .await?;
        Ok(())
    }

    /// Fetches a single message by id, as named by a doorbell.
    pub async fn get_session_mesh_message(
        &self,
        message_id: &str,
    ) -> anyhow::Result<Option<SessionMeshMessageRecord>> {
        let row = sqlx::query(
            r#"
SELECT message_id, from_thread_id, to_thread_id, content, hop, trigger_turn,
    created_at_ms, delivered_at_ms, delivery
FROM session_mesh_messages
WHERE message_id = ?
            "#,
        )
        .bind(message_id)
        .fetch_optional(self.pool.as_ref())
        .await?;

        row.map(session_mesh_message_from_row).transpose()
    }

    /// Lists messages addressed to `thread_id` created after `after_ms`.
    ///
    /// Used by the TUI poller to render inbound messages without a protocol
    /// round trip.
    pub async fn list_session_mesh_messages_for(
        &self,
        thread_id: ThreadId,
        after_ms: i64,
    ) -> anyhow::Result<Vec<SessionMeshMessageRecord>> {
        let rows = sqlx::query(
            r#"
SELECT message_id, from_thread_id, to_thread_id, content, hop, trigger_turn,
    created_at_ms, delivered_at_ms, delivery
FROM session_mesh_messages
WHERE to_thread_id = ? AND created_at_ms > ?
ORDER BY created_at_ms ASC
            "#,
        )
        .bind(thread_id.to_string())
        .bind(after_ms)
        .fetch_all(self.pool.as_ref())
        .await?;

        rows.into_iter()
            .map(session_mesh_message_from_row)
            .collect()
    }

    /// Records the outcome of a delivery attempt.
    pub async fn mark_session_mesh_message_delivered(
        &self,
        message_id: &str,
        delivered_at_ms: i64,
        delivery: &str,
    ) -> anyhow::Result<bool> {
        let result = sqlx::query(
            "UPDATE session_mesh_messages SET delivered_at_ms = ?, delivery = ? WHERE message_id = ?",
        )
        .bind(delivered_at_ms)
        .bind(delivery)
        .bind(message_id)
        .execute(self.pool.as_ref())
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Counts turn-starting deliveries from `from_thread_id` to `to_thread_id`
    /// since `since_ms`.
    ///
    /// Backs the rate limit that stops a peer from starting turns faster than a
    /// human could notice.
    pub async fn count_recent_session_mesh_triggers(
        &self,
        from_thread_id: ThreadId,
        to_thread_id: ThreadId,
        since_ms: i64,
    ) -> anyhow::Result<i64> {
        let row = sqlx::query(
            r#"
SELECT COUNT(*) AS trigger_count
FROM session_mesh_messages
WHERE from_thread_id = ? AND to_thread_id = ?
    AND trigger_turn = 1 AND delivery = 'started_turn' AND delivered_at_ms >= ?
            "#,
        )
        .bind(from_thread_id.to_string())
        .bind(to_thread_id.to_string())
        .bind(since_ms)
        .fetch_one(self.pool.as_ref())
        .await?;
        Ok(row.try_get("trigger_count")?)
    }
}

fn session_mesh_message_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<SessionMeshMessageRecord> {
    let from_thread_id: String = row.try_get("from_thread_id")?;
    let to_thread_id: String = row.try_get("to_thread_id")?;
    Ok(SessionMeshMessageRecord {
        message_id: row.try_get("message_id")?,
        from_thread_id: ThreadId::from_string(&from_thread_id)?,
        to_thread_id: ThreadId::from_string(&to_thread_id)?,
        content: row.try_get("content")?,
        hop: u32::try_from(row.try_get::<i64, _>("hop")?)?,
        trigger_turn: row.try_get::<i64, _>("trigger_turn")? != 0,
        created_at_ms: row.try_get("created_at_ms")?,
        delivered_at_ms: row.try_get("delivered_at_ms")?,
        delivery: row.try_get("delivery")?,
    })
}

#[cfg(test)]
#[path = "session_mesh_tests.rs"]
mod session_mesh_tests;
