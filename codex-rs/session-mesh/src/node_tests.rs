//! Two mesh nodes in one test process, over real sockets.
//!
//! Everything below runs against the real listener, the real handshake, and the
//! real limit checks. Only the store and the session are faked, which is why
//! this suite finishes in milliseconds without a database file or a model
//! client — the point of putting the socket logic in its own crate.

use super::*;
use crate::inbound::InboundDecision;
use crate::inbound::InboundFuture;
use crate::inbound::InboundMessage;
use crate::inbound::LocalSnapshot;
use crate::store::StoreFuture;
use crate::wire::Delivery;
use codex_state::SessionMeshMessageRecord;
use codex_state::SessionMeshPeerRecord;
use codex_state::SessionMeshPeerWithName;
use pretty_assertions::assert_eq;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Stands in for the shared `state_5.sqlite`, with the same visible semantics.
#[derive(Default)]
struct FakeStore {
    peers: Mutex<HashMap<ThreadId, (SessionMeshPeerRecord, Option<String>)>>,
    messages: Mutex<HashMap<String, SessionMeshMessageRecord>>,
    tasks: Mutex<Vec<codex_state::SessionMeshTaskRecord>>,
    /// Claim tokens, kept server-side exactly as the real store does.
    claim_tokens: Mutex<HashMap<String, String>>,
}

impl FakeStore {
    fn set_name(&self, thread_id: ThreadId, name: &str) {
        if let Some(entry) = self.peers.lock().expect("peers lock").get_mut(&thread_id) {
            entry.1 = Some(name.to_string());
        }
    }

    fn insert_raw_peer(&self, peer: SessionMeshPeerRecord) {
        self.peers
            .lock()
            .expect("peers lock")
            .insert(peer.thread_id, (peer, None));
    }

    fn message(&self, message_id: &str) -> Option<SessionMeshMessageRecord> {
        self.messages
            .lock()
            .expect("messages lock")
            .get(message_id)
            .cloned()
    }
}

impl MeshStore for FakeStore {
    fn upsert_peer<'a>(&'a self, peer: &'a SessionMeshPeerRecord) -> StoreFuture<'a, ()> {
        let peer = peer.clone();
        Box::pin(async move {
            let mut peers = self.peers.lock().expect("peers lock");
            let name = peers.get(&peer.thread_id).and_then(|entry| entry.1.clone());
            peers.insert(peer.thread_id, (peer, name));
            Ok(())
        })
    }

    fn delete_peer(&self, thread_id: ThreadId) -> StoreFuture<'_, bool> {
        Box::pin(async move {
            Ok(self
                .peers
                .lock()
                .expect("peers lock")
                .remove(&thread_id)
                .is_some())
        })
    }

    fn list_peers(&self) -> StoreFuture<'_, Vec<SessionMeshPeerWithName>> {
        Box::pin(async move {
            Ok(self
                .peers
                .lock()
                .expect("peers lock")
                .values()
                .map(|(peer, display_name)| SessionMeshPeerWithName {
                    peer: peer.clone(),
                    display_name: display_name.clone(),
                })
                .collect())
        })
    }

    fn enqueue_message<'a>(&'a self, message: &'a SessionMeshMessageRecord) -> StoreFuture<'a, ()> {
        let message = message.clone();
        Box::pin(async move {
            self.messages
                .lock()
                .expect("messages lock")
                .insert(message.message_id.clone(), message);
            Ok(())
        })
    }

    fn get_message<'a>(
        &'a self,
        message_id: &'a str,
    ) -> StoreFuture<'a, Option<SessionMeshMessageRecord>> {
        Box::pin(async move { Ok(self.message(message_id)) })
    }

    fn mark_delivered<'a>(
        &'a self,
        message_id: &'a str,
        delivered_at_ms: i64,
        delivery: &'a str,
    ) -> StoreFuture<'a, bool> {
        Box::pin(async move {
            let mut messages = self.messages.lock().expect("messages lock");
            let Some(message) = messages.get_mut(message_id) else {
                return Ok(false);
            };
            message.delivered_at_ms = Some(delivered_at_ms);
            message.delivery = Some(delivery.to_string());
            Ok(true)
        })
    }

    fn count_recent_triggers(
        &self,
        from_thread_id: ThreadId,
        to_thread_id: ThreadId,
        since_ms: i64,
    ) -> StoreFuture<'_, i64> {
        Box::pin(async move {
            Ok(self
                .messages
                .lock()
                .expect("messages lock")
                .values()
                .filter(|message| {
                    message.from_thread_id == from_thread_id
                        && message.to_thread_id == to_thread_id
                        && message.trigger_turn
                        && message.delivery.as_deref() == Some("started_turn")
                        && message.delivered_at_ms.unwrap_or_default() >= since_ms
                })
                .count() as i64)
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
            self.tasks
                .lock()
                .expect("tasks lock")
                .push(codex_state::SessionMeshTaskRecord {
                    task_id: task_id.to_string(),
                    queue: queue.to_string(),
                    title: title.to_string(),
                    body: body.to_string(),
                    priority,
                    status: "pending".to_string(),
                    created_by_thread_id: created_by,
                    created_at_ms: now_ms,
                    assigned_to_thread_id: assigned_to,
                    claimed_by_thread_id: None,
                    claimed_at_ms: None,
                    attempt_count: 0,
                    max_attempts: 3,
                    result_json: None,
                    last_error: None,
                    updated_at_ms: now_ms,
                });
            Ok(())
        })
    }

    fn claim_task<'a>(
        &'a self,
        queue: &'a str,
        claimant: ThreadId,
        claim_token: &'a str,
        now_ms: i64,
    ) -> StoreFuture<'a, Option<codex_state::SessionMeshTaskRecord>> {
        Box::pin(async move {
            let mut tasks = self.tasks.lock().expect("tasks lock");
            let Some(task) = tasks.iter_mut().find(|task| {
                task.queue == queue
                    && task.status == "pending"
                    && task
                        .assigned_to_thread_id
                        .is_none_or(|assigned| assigned == claimant)
            }) else {
                return Ok(None);
            };
            task.status = "claimed".to_string();
            task.claimed_by_thread_id = Some(claimant);
            task.claimed_at_ms = Some(now_ms);
            task.attempt_count += 1;
            self.claim_tokens
                .lock()
                .expect("tokens lock")
                .insert(task.task_id.clone(), claim_token.to_string());
            Ok(Some(task.clone()))
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
    ) -> StoreFuture<'a, codex_state::TaskReportOutcome> {
        Box::pin(async move {
            let token_matches = self
                .claim_tokens
                .lock()
                .expect("tokens lock")
                .get(task_id)
                .is_some_and(|token| token == claim_token);
            if !token_matches {
                return Ok(codex_state::TaskReportOutcome::ClaimLost);
            }
            let mut tasks = self.tasks.lock().expect("tasks lock");
            if let Some(task) = tasks.iter_mut().find(|task| task.task_id == task_id) {
                task.status = status.to_string();
                task.result_json = result_json.map(str::to_string);
                task.last_error = last_error.map(str::to_string);
                task.updated_at_ms = now_ms;
            }
            Ok(codex_state::TaskReportOutcome::Recorded)
        })
    }

    fn list_tasks<'a>(
        &'a self,
        queue: &'a str,
        _limit: i64,
    ) -> StoreFuture<'a, Vec<codex_state::SessionMeshTaskRecord>> {
        Box::pin(async move {
            Ok(self
                .tasks
                .lock()
                .expect("tasks lock")
                .iter()
                .filter(|task| task.queue == queue)
                .cloned()
                .collect())
        })
    }

    fn task_claimants<'a>(&'a self, queue: &'a str) -> StoreFuture<'a, Vec<ThreadId>> {
        Box::pin(async move {
            Ok(self
                .tasks
                .lock()
                .expect("tasks lock")
                .iter()
                .filter(|task| task.queue == queue && task.status == "claimed")
                .filter_map(|task| task.claimed_by_thread_id)
                .collect())
        })
    }

    fn find_peer_by_spawn_id<'a>(&'a self, spawn_id: &'a str) -> StoreFuture<'a, Option<ThreadId>> {
        Box::pin(async move {
            Ok(self
                .peers
                .lock()
                .expect("peers lock")
                .values()
                .find(|(peer, _)| peer.spawn_id.as_deref() == Some(spawn_id))
                .map(|(peer, _)| peer.thread_id))
        })
    }

    fn reclaim_tasks_from(&self, dead_claimant: ThreadId, now_ms: i64) -> StoreFuture<'_, u64> {
        Box::pin(async move {
            let mut reclaimed = 0;
            let mut tasks = self.tasks.lock().expect("tasks lock");
            for task in tasks.iter_mut() {
                if task.status == "claimed" && task.claimed_by_thread_id == Some(dead_claimant) {
                    task.status = if task.attempt_count >= task.max_attempts {
                        "failed".to_string()
                    } else {
                        "pending".to_string()
                    };
                    task.claimed_by_thread_id = None;
                    task.updated_at_ms = now_ms;
                    reclaimed += 1;
                }
            }
            Ok(reclaimed)
        })
    }
}

/// Stands in for a session, recording what it was handed.
#[derive(Default)]
struct FakeInbound {
    received: Mutex<Vec<InboundMessage>>,
    senders: Mutex<Vec<PeerHandle>>,
    status: Mutex<String>,
}

impl FakeInbound {
    fn new(status: &str) -> Self {
        Self {
            received: Mutex::new(Vec::new()),
            senders: Mutex::new(Vec::new()),
            status: Mutex::new(status.to_string()),
        }
    }

    fn received(&self) -> Vec<InboundMessage> {
        self.received.lock().expect("received lock").clone()
    }

    fn senders(&self) -> Vec<PeerHandle> {
        self.senders.lock().expect("senders lock").clone()
    }
}

impl MeshInbound for FakeInbound {
    fn on_message<'a>(
        &'a self,
        from: PeerHandle,
        message: InboundMessage,
    ) -> InboundFuture<'a, InboundDecision> {
        Box::pin(async move {
            self.senders.lock().expect("senders lock").push(from);
            let delivery = if message.trigger_turn {
                Delivery::StartedTurn
            } else {
                Delivery::Queued
            };
            self.received.lock().expect("received lock").push(message);
            InboundDecision::Accepted { delivery }
        })
    }

    fn on_probe(&self) -> InboundFuture<'_, LocalSnapshot> {
        Box::pin(async move {
            LocalSnapshot {
                status: self.status.lock().expect("status lock").clone(),
                cli_version: "test".to_string(),
            }
        })
    }
}

struct Harness {
    _temp_dir: tempfile::TempDir,
    config: MeshConfig,
    store: Arc<FakeStore>,
}

impl Harness {
    fn new() -> Self {
        let temp_dir = tempfile::TempDir::new().expect("temp dir");
        let config = MeshConfig::new(temp_dir.path());
        Self {
            _temp_dir: temp_dir,
            config,
            store: Arc::new(FakeStore::default()),
        }
    }

    async fn join(&self, thread_id: ThreadId, inbound: Arc<FakeInbound>) -> MeshNode {
        MeshNode::join(
            self.config.clone(),
            LocalSessionIdentity {
                thread_id,
                cwd: PathBuf::from("/w/api"),
                session_source: "cli".to_string(),
                cli_version: "0.0.22".to_string(),
                spawn_id: None,
                spawned_by: None,
            },
            Arc::clone(&self.store) as Arc<dyn MeshStore>,
            inbound as Arc<dyn MeshInbound>,
        )
        .await
        .expect("node should join")
    }
}

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

const A: &str = "5a6b0c0d0e0f";
const B: &str = "5a6b9a8b7c6d";

#[tokio::test]
async fn a_peer_listing_excludes_yourself_and_reports_the_peer_status() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let _b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("working")))
        .await;
    harness.store.set_name(thread_id(B), "web");

    let peers = a.list_peers().await.expect("listing should succeed");

    assert_eq!(peers.len(), 1, "a session must not list itself");
    assert_eq!(peers[0].thread_id, thread_id(B));
    assert_eq!(peers[0].display_name.as_deref(), Some("web"));
    // The status comes from the peer's own probe answer, not from a cached
    // guess in the registry row.
    assert_eq!(peers[0].status, PeerStatus::Working);
}

#[tokio::test]
async fn a_message_reaches_the_peer_and_starts_a_turn() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b_inbound = Arc::new(FakeInbound::new("idle"));
    let _b = harness.join(thread_id(B), Arc::clone(&b_inbound)).await;
    let peers = a.list_peers().await.expect("listing should succeed");

    let ack = a
        .send_message(&peers[0], "reply with the word pineapple", true, 0)
        .await
        .expect("delivery should succeed");

    assert!(ack.accepted);
    assert_eq!(ack.delivery, Delivery::StartedTurn);
    let received = b_inbound.received();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].content, "reply with the word pineapple");
    assert!(received[0].trigger_turn);
}

#[tokio::test]
async fn the_body_is_stored_before_the_doorbell_rings() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let _b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("idle")))
        .await;
    let peers = a.list_peers().await.expect("listing should succeed");

    a.send_message(&peers[0], "hello", true, 0)
        .await
        .expect("delivery should succeed");

    // The wire never carried the body, so the only place it can be is storage.
    // That is also what makes a failed delivery leave evidence.
    let stored: Vec<_> = harness
        .store
        .messages
        .lock()
        .expect("messages lock")
        .values()
        .cloned()
        .collect();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].content, "hello");
    assert_eq!(stored[0].delivery.as_deref(), Some("started_turn"));
}

#[tokio::test]
async fn a_second_turn_start_in_the_window_is_downgraded_not_dropped() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b_inbound = Arc::new(FakeInbound::new("idle"));
    let _b = harness.join(thread_id(B), Arc::clone(&b_inbound)).await;
    let peers = a.list_peers().await.expect("listing should succeed");

    a.send_message(&peers[0], "first", true, 0)
        .await
        .expect("first delivery should succeed");
    let second = a
        .send_message(&peers[0], "second", true, 0)
        .await
        .expect("second delivery should still succeed");

    // Downgraded, not refused: the message must still arrive, it just does not
    // get to start another turn. Dropping it would lose the content entirely.
    assert!(second.accepted);
    assert_eq!(second.delivery, Delivery::Queued);
    assert!(
        second
            .reject_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("queue-only")),
        "the sender must be told why: {:?}",
        second.reject_reason
    );
    let received = b_inbound.received();
    assert_eq!(received.len(), 2);
    assert!(!received[1].trigger_turn);
}

#[tokio::test]
async fn a_message_that_has_been_relayed_too_often_is_refused() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b_inbound = Arc::new(FakeInbound::new("idle"));
    let _b = harness.join(thread_id(B), Arc::clone(&b_inbound)).await;
    let peers = a.list_peers().await.expect("listing should succeed");

    // Two sessions replying to each other would otherwise burn tokens in both
    // terminals with nobody watching.
    let err = a
        .send_message(&peers[0], "round and round", true, 3)
        .await
        .expect_err("the hop limit must refuse this");

    assert!(err.to_string().contains("relayed"), "{err}");
    assert!(b_inbound.received().is_empty());
}

#[tokio::test]
async fn a_body_larger_than_the_cap_never_reaches_the_wire() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let _b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("idle")))
        .await;
    let peers = a.list_peers().await.expect("listing should succeed");
    let oversized = "x".repeat(harness.config.max_content_bytes + 1);

    let err = a
        .send_message(&peers[0], &oversized, true, 0)
        .await
        .expect_err("an oversized body must be refused");

    assert!(err.to_string().contains("limit is"), "{err}");
    assert!(
        harness
            .store
            .messages
            .lock()
            .expect("messages lock")
            .is_empty(),
        "a refused message must not be stored"
    );
}

#[tokio::test]
async fn a_dead_peer_is_reaped_from_the_listing() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    // A row whose owning process is long gone: exactly what a `kill -9` leaves
    // behind, since the teardown path never runs.
    harness.store.insert_raw_peer(SessionMeshPeerRecord {
        thread_id: thread_id(B),
        short_ref: short_ref_for(thread_id(B)),
        pid: 999_999,
        process_start_token: "linux:1".to_string(),
        boot_id: "boot-from-another-era".to_string(),
        socket_path: harness
            .config
            .socket_path(thread_id(B))
            .display()
            .to_string(),
        cwd: "/w/gone".to_string(),
        session_source: "cli".to_string(),
        cli_version: "0.0.22".to_string(),
        protocol_min: 1,
        protocol_max: 1,
        joined_at_ms: 0,
        spawn_id: None,
        spawned_by_thread_id: None,
    });

    let peers = a.list_peers().await.expect("listing should succeed");

    assert!(peers.is_empty(), "a dead peer must not be listed");
    // Reaping is a side effect of listing, so no heartbeat machinery is needed.
    assert!(
        harness.store.peers.lock().expect("peers lock").len() == 1,
        "only the live session should remain registered"
    );
}

#[tokio::test]
async fn leaving_withdraws_the_row_and_removes_the_socket() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let socket_path = harness.config.socket_path(thread_id(A));
    assert!(socket_path.exists());

    a.leave().await;

    assert!(harness.store.peers.lock().expect("peers lock").is_empty());
    assert!(!socket_path.exists());
    // The lock file must go too, or the socket directory grows by one
    // zero-byte file for every session that ever joined.
    assert!(!harness.config.socket_lock_path(thread_id(A)).exists());
}

#[tokio::test]
async fn reaping_a_dead_peer_also_clears_its_lock_file() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let dead_lock = harness.config.socket_lock_path(thread_id(B));
    std::fs::write(&dead_lock, b"").expect("lock file should be creatable");
    harness.store.insert_raw_peer(SessionMeshPeerRecord {
        thread_id: thread_id(B),
        short_ref: short_ref_for(thread_id(B)),
        pid: 999_999,
        process_start_token: "linux:1".to_string(),
        boot_id: "boot-from-another-era".to_string(),
        socket_path: harness
            .config
            .socket_path(thread_id(B))
            .display()
            .to_string(),
        cwd: "/w/gone".to_string(),
        session_source: "cli".to_string(),
        cli_version: "0.0.22".to_string(),
        protocol_min: 1,
        protocol_max: 1,
        joined_at_ms: 0,
        spawn_id: None,
        spawned_by_thread_id: None,
    });

    a.list_peers().await.expect("listing should succeed");

    assert!(!dead_lock.exists());
}

#[tokio::test]
async fn a_second_process_cannot_steal_a_live_session_socket() {
    let harness = Harness::new();
    let _a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;

    // Thread ids are stable across resume, so two processes resuming the same
    // thread contend for one socket path. The loser must fail loudly rather
    // than unlink a socket that is still serving.
    let result = MeshNode::join(
        harness.config.clone(),
        LocalSessionIdentity {
            thread_id: thread_id(A),
            cwd: PathBuf::from("/w/api"),
            session_source: "cli".to_string(),
            cli_version: "0.0.22".to_string(),
            spawn_id: None,
            spawned_by: None,
        },
        Arc::clone(&harness.store) as Arc<dyn MeshStore>,
        Arc::new(FakeInbound::new("idle")) as Arc<dyn MeshInbound>,
    )
    .await;
    let Err(err) = result else {
        panic!("a live socket must not be stolen");
    };

    assert!(
        err.to_string().contains("already owns") || err.to_string().contains("already owned"),
        "{err}"
    );
    assert!(harness.config.socket_path(thread_id(A)).exists());
}

#[tokio::test]
async fn a_doorbell_for_someone_elses_message_is_refused() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b_inbound = Arc::new(FakeInbound::new("idle"));
    let _b = harness.join(thread_id(B), Arc::clone(&b_inbound)).await;
    let peers = a.list_peers().await.expect("listing should succeed");

    // A message addressed to A, whose id is then rung at B's doorbell. Without
    // the recipient check a peer could replay any id it can guess.
    harness
        .store
        .enqueue_message(&SessionMeshMessageRecord {
            message_id: "not-yours".to_string(),
            from_thread_id: thread_id(B),
            to_thread_id: thread_id(A),
            content: "for a only".to_string(),
            hop: 0,
            trigger_turn: true,
            created_at_ms: 0,
            delivered_at_ms: None,
            delivery: None,
        })
        .await
        .expect("message should store");

    let mut connection = crate::client::PeerConnection::open(
        &harness.config,
        &harness.config.socket_path(peers[0].thread_id),
        &thread_id(A).to_string(),
        "0.0.22",
    )
    .await
    .expect("connection should open");
    let err = connection
        .send_doorbell("not-yours", &thread_id(A).to_string())
        .await
        .expect_err("a misaddressed doorbell must be refused");

    assert!(
        err.to_string().contains("not addressed to this session"),
        "{err}"
    );
    assert!(b_inbound.received().is_empty());
    assert_eq!(harness.store.message("not-yours").unwrap().delivery, None);
}

#[tokio::test]
async fn a_task_published_by_one_session_is_claimed_by_another() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("idle")))
        .await;

    let task_id = a
        .sender()
        .publish_task("default", "run the tests", "cargo test", 0, None)
        .await
        .expect("publish should succeed");
    let claimed = b
        .sender()
        .claim_task("default")
        .await
        .expect("claim should succeed")
        .expect("there is a task to claim");

    assert_eq!(claimed.0.task_id, task_id);
    assert_eq!(claimed.0.claimed_by_thread_id, Some(thread_id(B)));
    // The publisher must not also claim its own task out from under the worker.
    assert!(
        a.sender()
            .claim_task("default")
            .await
            .expect("claim should succeed")
            .is_none()
    );
}

#[tokio::test]
async fn a_task_held_by_a_departed_session_is_reclaimed_on_the_next_claim() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("idle")))
        .await;
    a.sender()
        .publish_task("default", "work", "body", 0, None)
        .await
        .expect("publish should succeed");
    b.sender()
        .claim_task("default")
        .await
        .expect("claim should succeed")
        .expect("there is a task");

    // B leaves without reporting, which is what a crash looks like from the
    // outside. The work must not be parked forever.
    b.leave().await;
    let reclaimed = a
        .sender()
        .claim_task("default")
        .await
        .expect("claim should succeed");

    assert!(reclaimed.is_some(), "a dead claimant's task must come back");
    assert_eq!(reclaimed.expect("task").0.attempt_count, 2);
}

#[tokio::test]
async fn a_report_carrying_a_reclaimed_token_changes_nothing() {
    let harness = Harness::new();
    let a = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let b = harness
        .join(thread_id(B), Arc::new(FakeInbound::new("idle")))
        .await;
    let task_id = a
        .sender()
        .publish_task("default", "work", "body", 0, None)
        .await
        .expect("publish should succeed");
    let (_, stale_token) = b
        .sender()
        .claim_task("default")
        .await
        .expect("claim should succeed")
        .expect("there is a task");
    b.leave().await;
    a.sender()
        .claim_task("default")
        .await
        .expect("claim should succeed")
        .expect("reclaimed task");

    // The original worker wakes up and reports. Without the token check this
    // would overwrite the state of whoever took the task over.
    let outcome = a
        .sender()
        .report_task(&task_id, &stale_token, "done", None, None)
        .await
        .expect("report should not error");

    assert_eq!(outcome, codex_state::TaskReportOutcome::ClaimLost);
}

#[tokio::test]
async fn a_result_for_a_departed_launcher_is_still_recorded() {
    let harness = Harness::new();
    let child = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    // The launcher is gone — the normal ending for a background session, since
    // outliving its launcher is the entire point.
    let departed_launcher = thread_id(B);

    let delivered = child
        .sender()
        .leave_message(departed_launcher, "[background session finished]", 1)
        .await
        .expect("recording a result must not fail because nobody is listening");

    assert!(!delivered, "there was nobody to ring");
    let stored: Vec<_> = harness
        .store
        .messages
        .lock()
        .expect("messages lock")
        .values()
        .cloned()
        .collect();
    assert_eq!(stored.len(), 1, "the result must survive for a later read");
    assert_eq!(stored[0].to_thread_id, departed_launcher);
    assert!(
        !stored[0].trigger_turn,
        "a finished background job must not seize its launcher's session"
    );
}

#[tokio::test]
async fn a_result_for_a_live_launcher_is_delivered_immediately() {
    let harness = Harness::new();
    let child = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    let launcher_inbound = Arc::new(FakeInbound::new("idle"));
    let _launcher = harness.join(thread_id(B), Arc::clone(&launcher_inbound)).await;

    let delivered = child
        .sender()
        .leave_message(thread_id(B), "[background session finished]", 1)
        .await
        .expect("delivery should not error");

    assert!(delivered);
    assert_eq!(launcher_inbound.received().len(), 1);
}

#[tokio::test]
async fn the_recipient_learns_who_sent_the_message() {
    let harness = Harness::new();
    let sender = harness
        .join(thread_id(A), Arc::new(FakeInbound::new("idle")))
        .await;
    harness.store.set_name(thread_id(A), "api");
    let recipient_inbound = Arc::new(FakeInbound::new("idle"));
    let _recipient = harness.join(thread_id(B), Arc::clone(&recipient_inbound)).await;
    let peers = sender.list_peers().await.expect("listing should succeed");

    sender
        .send_message(&peers[0], "do the thing", true, 0)
        .await
        .expect("delivery should succeed");

    // The recipient labels the message with this handle, so an unnamed sender
    // makes provenance useless — the point is to say *who*, not just *that*.
    let from = recipient_inbound.senders().pop().expect("a sender was recorded");
    assert_eq!(from.display_name.as_deref(), Some("api"));
    assert_eq!(from.name(), "api");
    assert_eq!(from.thread_id, thread_id(A));
}
