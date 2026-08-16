//! Storage the mesh needs, behind a trait.
//!
//! The trait exists so the socket, handshake, and rate-limit logic can be
//! tested against an in-memory fake — no SQLite file, no migrations, no
//! `codex_home`. That matters because this is the highest-risk code in the
//! feature (a socket that lets another local process start a turn in your
//! session) and it should not be gated behind the slowest test harness
//! available.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use codex_protocol::ThreadId;
use codex_state::SessionMeshMessageRecord;
use codex_state::SessionMeshPeerRecord;
use codex_state::SessionMeshPeerWithName;
use codex_state::SessionMeshTaskRecord;
use codex_state::StateRuntime;
use codex_state::TaskReportOutcome;

use crate::error::MeshError;

pub type StoreFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, MeshError>> + Send + 'a>>;

/// The registry and mailbox operations the mesh performs.
pub trait MeshStore: Send + Sync {
    fn upsert_peer<'a>(&'a self, peer: &'a SessionMeshPeerRecord) -> StoreFuture<'a, ()>;
    fn delete_peer(&self, thread_id: ThreadId) -> StoreFuture<'_, bool>;
    fn list_peers(&self) -> StoreFuture<'_, Vec<SessionMeshPeerWithName>>;
    fn enqueue_message<'a>(&'a self, message: &'a SessionMeshMessageRecord) -> StoreFuture<'a, ()>;
    fn get_message<'a>(
        &'a self,
        message_id: &'a str,
    ) -> StoreFuture<'a, Option<SessionMeshMessageRecord>>;
    fn mark_delivered<'a>(
        &'a self,
        message_id: &'a str,
        delivered_at_ms: i64,
        delivery: &'a str,
    ) -> StoreFuture<'a, bool>;
    fn count_recent_triggers(
        &self,
        from_thread_id: ThreadId,
        to_thread_id: ThreadId,
        since_ms: i64,
    ) -> StoreFuture<'_, i64>;

    #[allow(clippy::too_many_arguments)]
    fn publish_task<'a>(
        &'a self,
        task_id: &'a str,
        queue: &'a str,
        title: &'a str,
        body: &'a str,
        priority: i64,
        created_by: ThreadId,
        assigned_to: Option<ThreadId>,
        now_ms: i64,
    ) -> StoreFuture<'a, ()>;

    fn claim_task<'a>(
        &'a self,
        queue: &'a str,
        claimant: ThreadId,
        claim_token: &'a str,
        now_ms: i64,
    ) -> StoreFuture<'a, Option<SessionMeshTaskRecord>>;

    fn report_task<'a>(
        &'a self,
        task_id: &'a str,
        claim_token: &'a str,
        status: &'a str,
        result_json: Option<&'a str>,
        last_error: Option<&'a str>,
        now_ms: i64,
    ) -> StoreFuture<'a, TaskReportOutcome>;

    fn list_tasks<'a>(
        &'a self,
        queue: &'a str,
        limit: i64,
    ) -> StoreFuture<'a, Vec<SessionMeshTaskRecord>>;

    fn task_claimants<'a>(&'a self, queue: &'a str) -> StoreFuture<'a, Vec<ThreadId>>;

    fn reclaim_tasks_from(&self, dead_claimant: ThreadId, now_ms: i64) -> StoreFuture<'_, u64>;

    fn find_peer_by_spawn_id<'a>(&'a self, spawn_id: &'a str) -> StoreFuture<'a, Option<ThreadId>>;
}

/// The real store, backed by the shared `state_5.sqlite` database.
pub struct StateRuntimeStore {
    runtime: Arc<StateRuntime>,
}

impl StateRuntimeStore {
    pub fn new(runtime: Arc<StateRuntime>) -> Self {
        Self { runtime }
    }
}

/// Storage failures are reported as wire-level errors rather than swallowed:
/// an unreachable database must not look like an empty peer list.
fn store_error(err: anyhow::Error) -> MeshError {
    MeshError::Wire(format!("session mesh store error: {err}"))
}

impl MeshStore for StateRuntimeStore {
    fn upsert_peer<'a>(&'a self, peer: &'a SessionMeshPeerRecord) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            self.runtime
                .upsert_session_mesh_peer(peer)
                .await
                .map_err(store_error)
        })
    }

    fn delete_peer(&self, thread_id: ThreadId) -> StoreFuture<'_, bool> {
        Box::pin(async move {
            self.runtime
                .delete_session_mesh_peer(thread_id)
                .await
                .map_err(store_error)
        })
    }

    fn list_peers(&self) -> StoreFuture<'_, Vec<SessionMeshPeerWithName>> {
        Box::pin(async move {
            self.runtime
                .list_session_mesh_peers()
                .await
                .map_err(store_error)
        })
    }

    fn enqueue_message<'a>(&'a self, message: &'a SessionMeshMessageRecord) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            self.runtime
                .enqueue_session_mesh_message(message)
                .await
                .map_err(store_error)
        })
    }

    fn get_message<'a>(
        &'a self,
        message_id: &'a str,
    ) -> StoreFuture<'a, Option<SessionMeshMessageRecord>> {
        Box::pin(async move {
            self.runtime
                .get_session_mesh_message(message_id)
                .await
                .map_err(store_error)
        })
    }

    fn mark_delivered<'a>(
        &'a self,
        message_id: &'a str,
        delivered_at_ms: i64,
        delivery: &'a str,
    ) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            self.runtime
                .mark_session_mesh_message_delivered(message_id, delivered_at_ms, delivery)
                .await
                .map_err(store_error)
        })
    }

    fn count_recent_triggers(
        &self,
        from_thread_id: ThreadId,
        to_thread_id: ThreadId,
        since_ms: i64,
    ) -> StoreFuture<'_, i64> {
        Box::pin(async move {
            self.runtime
                .count_recent_session_mesh_triggers(from_thread_id, to_thread_id, since_ms)
                .await
                .map_err(store_error)
        })
    }

    fn publish_task<'a>(
        &'a self,
        task_id: &'a str,
        queue: &'a str,
        title: &'a str,
        body: &'a str,
        priority: i64,
        created_by: ThreadId,
        assigned_to: Option<ThreadId>,
        now_ms: i64,
    ) -> StoreFuture<'a, ()> {
        Box::pin(async move {
            self.runtime
                .publish_session_mesh_task(
                    task_id,
                    queue,
                    title,
                    body,
                    priority,
                    created_by,
                    assigned_to,
                    now_ms,
                )
                .await
                .map_err(store_error)
        })
    }

    fn claim_task<'a>(
        &'a self,
        queue: &'a str,
        claimant: ThreadId,
        claim_token: &'a str,
        now_ms: i64,
    ) -> StoreFuture<'a, Option<SessionMeshTaskRecord>> {
        Box::pin(async move {
            self.runtime
                .claim_session_mesh_task(queue, claimant, claim_token, now_ms)
                .await
                .map_err(store_error)
        })
    }

    fn report_task<'a>(
        &'a self,
        task_id: &'a str,
        claim_token: &'a str,
        status: &'a str,
        result_json: Option<&'a str>,
        last_error: Option<&'a str>,
        now_ms: i64,
    ) -> StoreFuture<'a, TaskReportOutcome> {
        Box::pin(async move {
            self.runtime
                .report_session_mesh_task(
                    task_id,
                    claim_token,
                    status,
                    result_json,
                    last_error,
                    now_ms,
                )
                .await
                .map_err(store_error)
        })
    }

    fn list_tasks<'a>(
        &'a self,
        queue: &'a str,
        limit: i64,
    ) -> StoreFuture<'a, Vec<SessionMeshTaskRecord>> {
        Box::pin(async move {
            self.runtime
                .list_session_mesh_tasks(queue, limit)
                .await
                .map_err(store_error)
        })
    }

    fn task_claimants<'a>(&'a self, queue: &'a str) -> StoreFuture<'a, Vec<ThreadId>> {
        Box::pin(async move {
            self.runtime
                .session_mesh_task_claimants(queue)
                .await
                .map_err(store_error)
        })
    }

    fn reclaim_tasks_from(&self, dead_claimant: ThreadId, now_ms: i64) -> StoreFuture<'_, u64> {
        Box::pin(async move {
            self.runtime
                .reclaim_session_mesh_tasks_from(dead_claimant, now_ms)
                .await
                .map_err(store_error)
        })
    }

    fn find_peer_by_spawn_id<'a>(&'a self, spawn_id: &'a str) -> StoreFuture<'a, Option<ThreadId>> {
        Box::pin(async move {
            self.runtime
                .find_session_mesh_peer_by_spawn_id(spawn_id)
                .await
                .map_err(store_error)
        })
    }
}
