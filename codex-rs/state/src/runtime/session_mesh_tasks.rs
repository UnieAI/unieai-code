//! The machine-local work queue.
//!
//! Claiming is a single `UPDATE … RETURNING`, which WAL and the existing busy
//! timeout make atomic without any application-level locking. There is
//! deliberately no time-based lease: a model turn routinely outlasts any lease
//! you would want to set, so expiry would hand the same task to a second
//! session while the first was still working on it. The failure that actually
//! needs handling is a claimant that died, and that is detectable directly.

use super::*;

/// A queued unit of work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionMeshTaskRecord {
    pub task_id: String,
    pub queue: String,
    pub title: String,
    pub body: String,
    pub priority: i64,
    pub status: String,
    pub created_by_thread_id: ThreadId,
    pub created_at_ms: i64,
    pub assigned_to_thread_id: Option<ThreadId>,
    pub claimed_by_thread_id: Option<ThreadId>,
    pub claimed_at_ms: Option<i64>,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub result_json: Option<String>,
    pub last_error: Option<String>,
    pub updated_at_ms: i64,
}

/// What happened to a report against a claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskReportOutcome {
    Recorded,
    /// The claim had already been taken away, so nothing was written.
    ///
    /// Reported rather than swallowed so the worker's model can be told to stop
    /// instead of continuing work whose result will be discarded.
    ClaimLost,
}

impl StateRuntime {
    /// Publishes a task.
    #[allow(clippy::too_many_arguments)]
    pub async fn publish_session_mesh_task(
        &self,
        task_id: &str,
        queue: &str,
        title: &str,
        body: &str,
        priority: i64,
        created_by_thread_id: ThreadId,
        assigned_to_thread_id: Option<ThreadId>,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"
INSERT INTO session_mesh_tasks (
    task_id, queue, title, body, priority, status, created_by_thread_id, created_at_ms,
    assigned_to_thread_id, updated_at_ms
) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
            "#,
        )
        .bind(task_id)
        .bind(queue)
        .bind(title)
        .bind(body)
        .bind(priority)
        .bind(created_by_thread_id.to_string())
        .bind(now_ms)
        .bind(assigned_to_thread_id.map(|id| id.to_string()))
        .bind(now_ms)
        .execute(self.pool.as_ref())
        .await?;
        Ok(())
    }

    /// Claims the next task for `claimant`, if there is one.
    ///
    /// Tasks addressed to this session come first: a direct assignment is a
    /// request, and letting an open task jump ahead of it would make assignment
    /// meaningless.
    pub async fn claim_session_mesh_task(
        &self,
        queue: &str,
        claimant: ThreadId,
        claim_token: &str,
        now_ms: i64,
    ) -> anyhow::Result<Option<SessionMeshTaskRecord>> {
        let row = sqlx::query(
            r#"
UPDATE session_mesh_tasks
SET status = 'claimed',
    claimed_by_thread_id = ?,
    claim_token = ?,
    claimed_at_ms = ?,
    attempt_count = attempt_count + 1,
    updated_at_ms = ?
WHERE task_id = (
    SELECT task_id FROM session_mesh_tasks
    WHERE queue = ?
      AND status = 'pending'
      AND (assigned_to_thread_id IS NULL OR assigned_to_thread_id = ?)
    ORDER BY (assigned_to_thread_id IS NULL), priority DESC, created_at_ms
    LIMIT 1
)
  AND status = 'pending'
RETURNING task_id, queue, title, body, priority, status, created_by_thread_id, created_at_ms,
    assigned_to_thread_id, claimed_by_thread_id, claimed_at_ms, attempt_count, max_attempts,
    result_json, last_error, updated_at_ms
            "#,
        )
        .bind(claimant.to_string())
        .bind(claim_token)
        .bind(now_ms)
        .bind(now_ms)
        .bind(queue)
        .bind(claimant.to_string())
        .fetch_optional(self.pool.as_ref())
        .await?;

        row.map(session_mesh_task_from_row).transpose()
    }

    /// Records the outcome of a claimed task.
    pub async fn report_session_mesh_task(
        &self,
        task_id: &str,
        claim_token: &str,
        status: &str,
        result_json: Option<&str>,
        last_error: Option<&str>,
        now_ms: i64,
    ) -> anyhow::Result<TaskReportOutcome> {
        // The token match is what makes a report idempotent: a worker whose
        // claim was reclaimed writes nothing rather than overwriting the result
        // of whoever took over.
        let result = sqlx::query(
            r#"
UPDATE session_mesh_tasks
SET status = ?, result_json = ?, last_error = ?, updated_at_ms = ?
WHERE task_id = ? AND claim_token = ?
            "#,
        )
        .bind(status)
        .bind(result_json)
        .bind(last_error)
        .bind(now_ms)
        .bind(task_id)
        .bind(claim_token)
        .execute(self.pool.as_ref())
        .await?;

        Ok(if result.rows_affected() > 0 {
            TaskReportOutcome::Recorded
        } else {
            TaskReportOutcome::ClaimLost
        })
    }

    /// Lists tasks in a queue, newest first.
    pub async fn list_session_mesh_tasks(
        &self,
        queue: &str,
        limit: i64,
    ) -> anyhow::Result<Vec<SessionMeshTaskRecord>> {
        let rows = sqlx::query(
            r#"
SELECT task_id, queue, title, body, priority, status, created_by_thread_id, created_at_ms,
    assigned_to_thread_id, claimed_by_thread_id, claimed_at_ms, attempt_count, max_attempts,
    result_json, last_error, updated_at_ms
FROM session_mesh_tasks
WHERE queue = ?
ORDER BY created_at_ms DESC
LIMIT ?
            "#,
        )
        .bind(queue)
        .bind(limit)
        .fetch_all(self.pool.as_ref())
        .await?;

        rows.into_iter().map(session_mesh_task_from_row).collect()
    }

    /// Returns the thread ids currently holding claims in `queue`.
    ///
    /// Split from the reclaim itself so the caller can probe liveness without
    /// holding a transaction open across a socket connect.
    pub async fn session_mesh_task_claimants(&self, queue: &str) -> anyhow::Result<Vec<ThreadId>> {
        let rows = sqlx::query(
            r#"
SELECT DISTINCT claimed_by_thread_id
FROM session_mesh_tasks
WHERE queue = ? AND status = 'claimed' AND claimed_by_thread_id IS NOT NULL
            "#,
        )
        .bind(queue)
        .fetch_all(self.pool.as_ref())
        .await?;

        rows.into_iter()
            .map(|row| {
                let thread_id: String = row.try_get("claimed_by_thread_id")?;
                Ok(ThreadId::from_string(&thread_id)?)
            })
            .collect()
    }

    /// Returns claimed tasks held by `dead_claimant` to the pending pool.
    ///
    /// A task that has exhausted its attempts is failed instead, so a task that
    /// kills whoever claims it cannot cycle forever.
    pub async fn reclaim_session_mesh_tasks_from(
        &self,
        dead_claimant: ThreadId,
        now_ms: i64,
    ) -> anyhow::Result<u64> {
        let requeued = sqlx::query(
            r#"
UPDATE session_mesh_tasks
SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
    claimed_by_thread_id = NULL,
    claim_token = NULL,
    claimed_at_ms = NULL,
    last_error = CASE
        WHEN attempt_count >= max_attempts
        THEN 'claimant exited and the task ran out of attempts'
        ELSE last_error
    END,
    updated_at_ms = ?
WHERE status = 'claimed' AND claimed_by_thread_id = ?
            "#,
        )
        .bind(now_ms)
        .bind(dead_claimant.to_string())
        .execute(self.pool.as_ref())
        .await?;
        Ok(requeued.rows_affected())
    }
}

fn session_mesh_task_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<SessionMeshTaskRecord> {
    let created_by: String = row.try_get("created_by_thread_id")?;
    let assigned_to: Option<String> = row.try_get("assigned_to_thread_id")?;
    let claimed_by: Option<String> = row.try_get("claimed_by_thread_id")?;
    Ok(SessionMeshTaskRecord {
        task_id: row.try_get("task_id")?,
        queue: row.try_get("queue")?,
        title: row.try_get("title")?,
        body: row.try_get("body")?,
        priority: row.try_get("priority")?,
        status: row.try_get("status")?,
        created_by_thread_id: ThreadId::from_string(&created_by)?,
        created_at_ms: row.try_get("created_at_ms")?,
        assigned_to_thread_id: assigned_to
            .map(|id| ThreadId::from_string(&id))
            .transpose()?,
        claimed_by_thread_id: claimed_by
            .map(|id| ThreadId::from_string(&id))
            .transpose()?,
        claimed_at_ms: row.try_get("claimed_at_ms")?,
        attempt_count: row.try_get("attempt_count")?,
        max_attempts: row.try_get("max_attempts")?,
        result_json: row.try_get("result_json")?,
        last_error: row.try_get("last_error")?,
        updated_at_ms: row.try_get("updated_at_ms")?,
    })
}

#[cfg(test)]
#[path = "session_mesh_tasks_tests.rs"]
mod session_mesh_tasks_tests;
