//! A session's membership in the mesh.

use std::path::PathBuf;
use std::sync::Arc;

use codex_protocol::ThreadId;
use codex_state::SESSION_MESH_DELIVERY_APPROVED;
use codex_state::SESSION_MESH_DELIVERY_DENIED;
use codex_state::SESSION_MESH_DELIVERY_HELD;
use codex_state::SessionMeshMessageRecord;
use codex_state::SessionMeshPeerRecord;
use codex_state::SessionMeshPeerWithName;
use codex_uds::UnixListener;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use unieai_utils_process_liveness::ProcessIdentity;

use crate::client::PeerConnection;
use crate::config::MeshConfig;
use crate::config::PROTOCOL_VERSION_MAX;
use crate::config::PROTOCOL_VERSION_MIN;
use crate::error::MeshError;
use crate::identity::LocalSessionIdentity;
use crate::identity::PeerHandle;
use crate::identity::PeerSelector;
use crate::identity::PeerStatus;
use crate::identity::resolve_peer;
use crate::identity::short_ref_for;
use crate::inbound::MeshInbound;
use crate::inbound::MessageKind;
use crate::server::ServerContext;
use crate::server::now_ms;
use crate::server::run_acceptor;
use crate::store::MeshStore;
use crate::unieai_chain::PeerChain;
use crate::unieai_permissions::PermissionMode;
use crate::wire::Ack;

use crate::config::MAX_SOCKET_PATH_LEN;

/// The outbound half of mesh membership: discovery and delivery, with no
/// listener of its own.
///
/// Split out because some callers must be able to reach peers without becoming
/// one. The TUI is the case that forces it: it sends on behalf of its session,
/// which already has a listener, and publishing a second registry row for the
/// same session would show the user a duplicate of themselves.
#[derive(Clone)]
pub struct MeshSender {
    config: MeshConfig,
    from_thread_id: ThreadId,
    cli_version: String,
    store: Arc<dyn MeshStore>,
    /// Engine stamped on outgoing messages.
    engine: String,
}

/// What became of a held message the user decided on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldResolution {
    /// Approved and delivered; carries the recipient's delivery outcome.
    Delivered(Ack),
    /// Refused; the sender has been told.
    Denied,
}

/// Engine name used when a caller does not say.
pub const DEFAULT_ENGINE: &str = "codex";

/// This session's membership. Dropping it withdraws the session.
pub struct MeshNode {
    sender: MeshSender,
    identity: LocalSessionIdentity,
    shutdown: CancellationToken,
    socket_path: PathBuf,
    /// Held for the session's lifetime so a second process resuming the same
    /// thread fails loudly instead of racing us for the socket path.
    _socket_lock: std::fs::File,
    /// The acceptor's context, reused to deliver messages picked up at start.
    context: Arc<ServerContext>,
}

impl MeshNode {
    /// Binds this session's socket and publishes its registry row.
    pub async fn join(
        config: MeshConfig,
        identity: LocalSessionIdentity,
        store: Arc<dyn MeshStore>,
        inbound: Arc<dyn MeshInbound>,
    ) -> Result<Self, MeshError> {
        let socket_path = config.socket_path(identity.thread_id);
        // `sockaddr_un.sun_path` is a fixed 108-byte buffer on Linux and 104 on
        // macOS, so a long `CODEX_HOME` makes the mesh unbindable. Checking here
        // turns an opaque `SUN_LEN` errno into something a user can act on.
        if socket_path.as_os_str().len() >= MAX_SOCKET_PATH_LEN {
            return Err(MeshError::Unsupported {
                reason: format!(
                    "session mesh socket path is {} bytes, but the platform limit is {}: {}. \
Use a shorter CODEX_HOME.",
                    socket_path.as_os_str().len(),
                    MAX_SOCKET_PATH_LEN,
                    socket_path.display()
                ),
            });
        }
        codex_uds::prepare_private_socket_directory(config.socket_dir()).await?;

        // The lock is taken *before* the reclaim probe. `ThreadId` is stable
        // across resume, so two processes resuming the same thread contend for
        // one path, and probe-then-unlink has a window where both conclude the
        // path is stale and one steals the other's socket.
        let socket_lock = acquire_socket_lock(config.socket_lock_path(identity.thread_id)).await?;

        codex_uds::reclaim_stale_socket_path(&socket_path, "session mesh socket")
            .await
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::AddrInUse {
                    MeshError::SocketOwned {
                        path: socket_path.clone(),
                    }
                } else {
                    MeshError::Io(err)
                }
            })?;

        let listener = UnixListener::bind(&socket_path).await?;
        // Bind applies the umask, so this must run after it, not before.
        codex_uds::restrict_socket_permissions(&socket_path).await?;

        // Retention runs here because joining is the one moment every session
        // passes through; it is a single indexed DELETE.
        let retention_ms = config.message_retention.as_millis() as i64;
        if let Err(err) = store
            .prune_messages(now_ms().saturating_sub(retention_ms))
            .await
        {
            warn!("failed to prune old session mesh messages: {err}");
        }

        let process = ProcessIdentity::current().await?;
        store
            .upsert_peer(&SessionMeshPeerRecord {
                thread_id: identity.thread_id,
                short_ref: short_ref_for(identity.thread_id),
                pid: process.pid,
                process_start_token: process.start_token,
                boot_id: process.boot_id,
                socket_path: socket_path.display().to_string(),
                cwd: identity.cwd.display().to_string(),
                session_source: identity.session_source.clone(),
                cli_version: identity.cli_version.clone(),
                protocol_min: PROTOCOL_VERSION_MIN,
                protocol_max: PROTOCOL_VERSION_MAX,
                joined_at_ms: now_ms(),
                spawn_id: identity.spawn_id.clone(),
                spawned_by_thread_id: identity.spawned_by,
            })
            .await?;

        let shutdown = CancellationToken::new();
        let context = Arc::new(ServerContext {
            config: config.clone(),
            local_thread_id: identity.thread_id,
            cli_version: identity.cli_version.clone(),
            store: Arc::clone(&store),
            inbound,
            local_uid: current_uid(),
            chain: Arc::new(PeerChain::new(config.max_auto_turns_per_peer)),
        });
        tokio::spawn(run_acceptor(
            listener,
            Arc::clone(&context),
            shutdown.clone(),
        ));

        Ok(Self {
            sender: MeshSender {
                config,
                from_thread_id: identity.thread_id,
                cli_version: identity.cli_version.clone(),
                store,
                engine: identity.engine.clone(),
            },
            identity,
            shutdown,
            socket_path,
            _socket_lock: socket_lock,
            context,
        })
    }

    /// Delivers messages left for this session while it was not running.
    ///
    /// They arrive queued, never starting a turn by themselves: whatever they
    /// were about may be long over, and the user should see them before the
    /// model acts on them. Messages older than the retention window are
    /// ignored (and pruned at join). Returns how many were delivered.
    pub async fn deliver_pending(&self) -> usize {
        let retention_ms = self.sender.config.message_retention.as_millis() as i64;
        let pending = match self
            .sender
            .store
            .list_pending_messages(
                self.identity.thread_id,
                now_ms().saturating_sub(retention_ms),
            )
            .await
        {
            Ok(pending) => pending,
            Err(err) => {
                warn!("failed to read pending session mesh messages: {err}");
                return 0;
            }
        };
        let mut delivered = 0;
        for message in pending {
            let body = crate::server::process_message(
                &self.context,
                message,
                /*force_queue*/ true,
                &self.identity.cli_version,
            )
            .await;
            if matches!(body, crate::wire::Body::Ack(Ack { accepted: true, .. })) {
                delivered += 1;
            }
        }
        delivered
    }

    /// This session's user submitted input, so the conversation has a human
    /// in it again: hop counting and the consecutive-turn budget restart.
    pub fn note_user_input(&self) {
        self.context.chain.note_user_input();
    }

    /// Hop to stamp on a message this session sends now: one more than the
    /// furthest-travelled peer message it has received since its user last
    /// spoke, or zero.
    pub fn outbound_hop(&self) -> u32 {
        self.context.chain.outbound_hop()
    }

    pub fn thread_id(&self) -> ThreadId {
        self.identity.thread_id
    }

    /// The session that launched this one, when there was one.
    pub fn spawned_by(&self) -> Option<ThreadId> {
        self.identity.spawned_by
    }

    /// The outbound half, for callers that only need to reach peers.
    pub fn sender(&self) -> &MeshSender {
        &self.sender
    }

    /// Lists peers that answer, excluding this session.
    pub async fn list_peers(&self) -> Result<Vec<PeerHandle>, MeshError> {
        self.sender.list_peers().await
    }

    /// Resolves a selector against the live peers, refusing to guess.
    pub async fn resolve(&self, selector: &PeerSelector) -> Result<PeerHandle, MeshError> {
        self.sender.resolve(selector).await
    }

    /// Stores a message and rings the recipient's doorbell.
    pub async fn send_message(
        &self,
        to: &PeerHandle,
        content: &str,
        trigger_turn: bool,
        hop: u32,
        permissions: Option<PermissionMode>,
    ) -> Result<Ack, MeshError> {
        self.sender
            .send_message(to, content, trigger_turn, hop, permissions)
            .await
    }

    /// Withdraws this session from the mesh.
    ///
    /// Takes `&self` rather than consuming: the node is shared, and an
    /// in-flight tool call still holding a handle must not be able to keep the
    /// registry row and socket behind after shutdown.
    pub async fn leave(&self) {
        self.shutdown.cancel();
        if let Err(err) = self.sender.store.delete_peer(self.identity.thread_id).await {
            warn!("failed to withdraw session mesh peer row: {err}");
        }
        if let Err(err) = tokio::fs::remove_file(&self.socket_path).await
            && err.kind() != std::io::ErrorKind::NotFound
        {
            warn!(
                "failed to remove session mesh socket {}: {err}",
                self.socket_path.display()
            );
        }
        // Unlinked last, and only after the socket is gone: a process joining
        // this same thread id concurrently either waits on the lock we still
        // hold, or takes a fresh one and finds no socket of ours to collide
        // with. Leaving these behind would grow the socket directory by one
        // zero-byte file per session that ever joined.
        let _ =
            tokio::fs::remove_file(self.sender.config.socket_lock_path(self.identity.thread_id))
                .await;
    }
}

impl MeshSender {
    /// Builds a sender that can reach peers without joining as one.
    pub fn new(
        config: MeshConfig,
        from_thread_id: ThreadId,
        cli_version: String,
        store: Arc<dyn MeshStore>,
    ) -> Self {
        Self {
            config,
            from_thread_id,
            cli_version,
            store,
            engine: DEFAULT_ENGINE.to_string(),
        }
    }

    /// Sets the engine stamped on outgoing messages.
    pub fn with_engine(mut self, engine: impl Into<String>) -> Self {
        self.engine = engine.into();
        self
    }

    pub fn thread_id(&self) -> ThreadId {
        self.from_thread_id
    }

    /// Lists peers that answer, excluding the sender itself.
    ///
    /// Every candidate is probed rather than trusted: a registry row only means
    /// some process published it and did not clean up. Rows whose process is
    /// provably gone are reaped as a side effect, which is why a `kill -9`ed
    /// session disappears without any heartbeat machinery.
    pub async fn list_peers(&self) -> Result<Vec<PeerHandle>, MeshError> {
        let rows = self.store.list_peers().await?;

        // Probed concurrently: one wedged peer costs the connect timeout once,
        // not once per peer after it.
        let mut probes = tokio::task::JoinSet::new();
        for (index, row) in rows.into_iter().enumerate() {
            if row.peer.thread_id == self.from_thread_id {
                continue;
            }
            let sender = self.clone();
            probes.spawn(async move { (index, sender.probe_row(row).await) });
        }

        let mut peers = Vec::new();
        while let Some(joined) = probes.join_next().await {
            if let Ok((index, Some(peer))) = joined {
                peers.push((index, peer));
            }
        }
        // Keep the registry's newest-first order regardless of which probe
        // answered first.
        peers.sort_by_key(|(index, _)| *index);
        Ok(peers.into_iter().map(|(_, peer)| peer).collect())
    }

    /// Probes one registry row, reaping it when its owner is gone.
    async fn probe_row(&self, row: SessionMeshPeerWithName) -> Option<PeerHandle> {
        let identity = ProcessIdentity {
            pid: row.peer.pid,
            start_token: row.peer.process_start_token.clone(),
            boot_id: row.peer.boot_id.clone(),
        };
        // Cheap pre-filter first: reading /proc beats opening a socket for a
        // process that is provably gone.
        if !identity.is_possibly_alive().await {
            self.reap(row.peer.thread_id, &row.peer.socket_path).await;
            return None;
        }

        let status = match self.probe(&row.peer.socket_path).await {
            Ok(status) => status,
            Err(_) => {
                self.reap(row.peer.thread_id, &row.peer.socket_path).await;
                return None;
            }
        };

        Some(PeerHandle {
            thread_id: row.peer.thread_id,
            short_ref: row.peer.short_ref,
            display_name: row.display_name,
            cwd: PathBuf::from(row.peer.cwd),
            status,
        })
    }

    /// Resolves a selector against the live peers, refusing to guess.
    pub async fn resolve(&self, selector: &PeerSelector) -> Result<PeerHandle, MeshError> {
        let peers = self.list_peers().await?;
        resolve_peer(selector, &peers)
    }

    /// Stores a message and rings the recipient's doorbell.
    ///
    /// The message is written before the doorbell so a delivery that fails
    /// mid-flight leaves a record instead of vanishing. `permissions` is this
    /// session's mode right now; the recipient compares it with its own to
    /// decide whether the message must wait for its user.
    pub async fn send_message(
        &self,
        to: &PeerHandle,
        content: &str,
        trigger_turn: bool,
        hop: u32,
        permissions: Option<PermissionMode>,
    ) -> Result<Ack, MeshError> {
        if content.len() > self.config.max_content_bytes {
            return Err(MeshError::Wire(format!(
                "message body is {} bytes, limit is {}",
                content.len(),
                self.config.max_content_bytes
            )));
        }

        let message_id = uuid::Uuid::new_v4().to_string();
        self.store
            .enqueue_message(&self.record(
                &message_id,
                to.thread_id,
                content,
                hop,
                trigger_turn,
                MessageKind::Message,
                permissions,
            ))
            .await?;

        let result = self.ring(to.thread_id, &message_id).await;
        if let Err(err) = &result {
            // The sender is told this failed, so the message must not turn up
            // later through startup pickup as if it had been sent. Only an
            // untouched row is marked: if the recipient did claim it before
            // the connection broke, its own record stands.
            let _ = self
                .store
                .transition_message(&message_id, None, &format!("failed:{err}"))
                .await;
        }
        result
    }

    /// Tells `to` what became of a message it sent. Notices never start a
    /// turn and are never held. Best-effort: stored even when `to` is not
    /// running, so it is picked up when it next starts.
    pub async fn send_notice(&self, to: ThreadId, content: &str) -> Result<bool, MeshError> {
        let message_id = uuid::Uuid::new_v4().to_string();
        self.store
            .enqueue_message(&self.record(
                &message_id,
                to,
                content,
                /*hop*/ 0,
                /*trigger_turn*/ false,
                MessageKind::Notice,
                /*permissions*/ None,
            ))
            .await?;
        Ok(self.ring(to, &message_id).await.is_ok())
    }

    /// Applies the user's decision on a message held for this session.
    ///
    /// Approval moves the message to `approved` and rings this session's own
    /// doorbell, which delivers it through the normal path (the hold check
    /// is skipped for an approved message; every other check still applies).
    /// Denial records it as `denied`. Either way the sender gets a notice.
    /// A message that is no longer held (already decided, or expired) is an
    /// error, so a double click cannot deliver twice.
    pub async fn resolve_held(
        &self,
        message_id: &str,
        approve: bool,
    ) -> Result<HeldResolution, MeshError> {
        let message = self
            .store
            .get_message(message_id)
            .await?
            .filter(|message| message.to_thread_id == self.from_thread_id)
            .ok_or_else(|| MeshError::Wire(format!("no held message {message_id} here")))?;
        let next = if approve {
            SESSION_MESH_DELIVERY_APPROVED
        } else {
            SESSION_MESH_DELIVERY_DENIED
        };
        if !self
            .store
            .transition_message(message_id, Some(SESSION_MESH_DELIVERY_HELD), next)
            .await?
        {
            return Err(MeshError::Wire(format!(
                "message {message_id} is no longer waiting for approval"
            )));
        }

        if !approve {
            let _ = self
                .store
                .mark_delivered(message_id, now_ms(), SESSION_MESH_DELIVERY_DENIED)
                .await;
            let _ = self
                .send_notice(
                    message.from_thread_id,
                    &format!(
                        "Your message {message_id} was DENIED by this session's user and was not \
delivered. Do not resend it, rephrase it, or route it through another session; tell your user \
instead."
                    ),
                )
                .await;
            return Ok(HeldResolution::Denied);
        }

        let ack = self.ring(self.from_thread_id, message_id).await?;
        let _ = self
            .send_notice(
                message.from_thread_id,
                &format!(
                    "Your message {message_id} was approved by this session's user and delivered \
({}).",
                    ack.delivery.as_str()
                ),
            )
            .await;
        Ok(HeldResolution::Delivered(ack))
    }

    #[allow(clippy::too_many_arguments)]
    fn record(
        &self,
        message_id: &str,
        to: ThreadId,
        content: &str,
        hop: u32,
        trigger_turn: bool,
        kind: MessageKind,
        permissions: Option<PermissionMode>,
    ) -> SessionMeshMessageRecord {
        SessionMeshMessageRecord {
            message_id: message_id.to_string(),
            from_thread_id: self.from_thread_id,
            to_thread_id: to,
            content: content.to_string(),
            hop,
            trigger_turn,
            created_at_ms: now_ms(),
            delivered_at_ms: None,
            delivery: None,
            kind: kind.as_str().to_string(),
            sender_engine: Some(self.engine.clone()),
            sender_sandbox: permissions.map(|mode| mode.sandbox.as_str().to_string()),
            sender_approval: permissions.map(|mode| mode.approval.as_str().to_string()),
        }
    }

    /// Rings `to`'s doorbell for a stored message.
    async fn ring(&self, to: ThreadId, message_id: &str) -> Result<Ack, MeshError> {
        let socket_path = self.config.socket_path(to);
        let mut connection = PeerConnection::open(
            &self.config,
            &socket_path,
            &self.from_thread_id.to_string(),
            &self.cli_version,
        )
        .await?;
        connection
            .send_doorbell(message_id, &self.from_thread_id.to_string())
            .await
    }

    /// Publishes a task other sessions can pick up.
    pub async fn publish_task(
        &self,
        queue: &str,
        title: &str,
        body: &str,
        priority: i64,
        assigned_to: Option<ThreadId>,
    ) -> Result<String, MeshError> {
        let task_id = uuid::Uuid::new_v4().to_string();
        self.store
            .publish_task(
                &task_id,
                queue,
                title,
                body,
                priority,
                self.from_thread_id,
                assigned_to,
                now_ms(),
            )
            .await?;
        Ok(task_id)
    }

    /// Claims the next task, returning it with the token needed to report on it.
    ///
    /// Dead claimants are swept first so a session that crashed mid-task does
    /// not park it forever. The sweep runs here rather than on a timer because
    /// this is the moment someone actually wants the work.
    pub async fn claim_task(
        &self,
        queue: &str,
    ) -> Result<Option<(codex_state::SessionMeshTaskRecord, String)>, MeshError> {
        self.reclaim_dead_claims(queue).await;
        let claim_token = uuid::Uuid::new_v4().to_string();
        let claimed = self
            .store
            .claim_task(queue, self.from_thread_id, &claim_token, now_ms())
            .await?;
        Ok(claimed.map(|task| (task, claim_token)))
    }

    /// Records the outcome of a claimed task.
    pub async fn report_task(
        &self,
        task_id: &str,
        claim_token: &str,
        status: &str,
        result_json: Option<&str>,
        last_error: Option<&str>,
    ) -> Result<codex_state::TaskReportOutcome, MeshError> {
        self.store
            .report_task(
                task_id,
                claim_token,
                status,
                result_json,
                last_error,
                now_ms(),
            )
            .await
    }

    /// Lists tasks in a queue, sweeping dead claims first so the statuses shown
    /// are the ones a claim would actually see.
    pub async fn list_tasks(
        &self,
        queue: &str,
        limit: i64,
    ) -> Result<Vec<codex_state::SessionMeshTaskRecord>, MeshError> {
        self.reclaim_dead_claims(queue).await;
        self.store.list_tasks(queue, limit).await
    }

    /// Returns tasks held by claimants that are no longer running.
    ///
    /// Liveness is probed outside any transaction, which is why claimants are
    /// collected first: holding a database write open across a socket connect
    /// would block every other session on the machine.
    async fn reclaim_dead_claims(&self, queue: &str) {
        let Ok(claimants) = self.store.task_claimants(queue).await else {
            return;
        };
        let live: Vec<ThreadId> = match self.store.list_peers().await {
            Ok(peers) => peers.into_iter().map(|peer| peer.peer.thread_id).collect(),
            Err(_) => return,
        };
        for claimant in claimants {
            // A claimant that is still registered is treated as alive: the
            // registry is only pruned by an actual probe, so an unregistered
            // claimant has already failed one.
            if live.contains(&claimant) || claimant == self.from_thread_id {
                continue;
            }
            if let Err(err) = self.store.reclaim_tasks_from(claimant, now_ms()).await {
                warn!("failed to reclaim tasks from {claimant}: {err}");
            }
        }
    }

    /// Records a message for a recipient that may no longer be running.
    ///
    /// The row is written whether or not the doorbell can be rung, because the
    /// caller that needs this — a background session finishing after its
    /// launcher has gone — is the common case, not the exception. Requiring a
    /// live recipient would throw the result away exactly when it matters most.
    /// The recipient picks it up from its inbox on a later run.
    pub async fn leave_message(
        &self,
        to: ThreadId,
        content: &str,
        hop: u32,
        permissions: Option<PermissionMode>,
    ) -> Result<bool, MeshError> {
        let message_id = uuid::Uuid::new_v4().to_string();
        self.store
            .enqueue_message(&self.record(
                &message_id,
                to,
                content,
                hop,
                // Never starts a turn: nobody asked for a background job
                // ending to take over their session.
                /*trigger_turn*/
                false,
                MessageKind::Message,
                permissions,
            ))
            .await?;

        // Stored but undelivered is a valid resting state: the recipient's
        // startup pickup (`MeshNode::deliver_pending`) delivers it later.
        Ok(self.ring(to, &message_id).await.is_ok())
    }

    /// Launches a session that outlives this one and returns it once it has
    /// registered.
    ///
    /// The child's thread id does not exist until the child builds its own
    /// session, so the launcher mints a `spawn_id`, passes it in the child's
    /// environment, and waits for it to appear in the registry.
    pub async fn spawn_child(
        &self,
        params: crate::spawn::SpawnChildParams,
    ) -> Result<crate::spawn::SpawnedChild, MeshError> {
        let exe = std::env::current_exe()?;
        let log_dir = self.config.child_log_dir();
        tokio::fs::create_dir_all(&log_dir).await?;
        let spawn_id = uuid::Uuid::new_v4().to_string();
        let log_path = log_dir.join(format!("{spawn_id}.log"));
        let stdout = std::fs::File::create(&log_path)?;
        let stderr = std::fs::OpenOptions::new().append(true).open(&log_path)?;

        let mut command = crate::spawn::child_command(
            &exe,
            &params,
            &spawn_id,
            self.from_thread_id,
            stdout,
            stderr,
        );
        let child = command.spawn()?;
        let pid = child.id().unwrap_or_default();
        // Detached on purpose: dropping the handle must not signal the child.
        drop(child);

        let thread_id = crate::spawn::await_rendezvous(
            &spawn_id,
            self.config.spawn_rendezvous_timeout,
            &log_path,
            |spawn_id| async move { self.store.find_peer_by_spawn_id(&spawn_id).await },
        )
        .await?;

        Ok(crate::spawn::SpawnedChild {
            thread_id,
            pid,
            log_path,
        })
    }

    async fn probe(&self, socket_path: &str) -> Result<PeerStatus, MeshError> {
        let mut connection = PeerConnection::open(
            &self.config,
            std::path::Path::new(socket_path),
            &self.from_thread_id.to_string(),
            &self.cli_version,
        )
        .await?;
        Ok(connection.probe().await?.peer_status())
    }

    /// Removes a row whose owner is gone, and the files it left behind.
    async fn reap(&self, thread_id: ThreadId, socket_path: &str) {
        if let Err(err) = self.store.delete_peer(thread_id).await {
            warn!("failed to reap session mesh peer {thread_id}: {err}");
            return;
        }
        let socket_path = std::path::Path::new(socket_path);
        // Only unlink what is actually a stale socket, so a path that has since
        // been rebound by a live process is left alone.
        if codex_uds::is_stale_socket_path(socket_path)
            .await
            .unwrap_or(false)
        {
            let _ = tokio::fs::remove_file(socket_path).await;
        }
        // The owner is provably gone, so nothing holds its lock file either.
        let _ = tokio::fs::remove_file(self.config.socket_lock_path(thread_id)).await;
    }
}

/// The uid this process runs as.
#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `getuid` takes no arguments and cannot fail.
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    // Unreachable in practice: the mesh refuses to serve where peer credentials
    // cannot be verified, and this value is only compared against them.
    u32::MAX
}

/// Takes an exclusive advisory lock on the socket's lock file.
async fn acquire_socket_lock(lock_path: PathBuf) -> Result<std::fs::File, MeshError> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        file.try_lock().map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!(
                    "another process already owns this session's mesh socket ({})",
                    lock_path.display()
                ),
            )
        })?;
        Ok::<_, std::io::Error>(file)
    })
    .await
    .map_err(|err| MeshError::Wire(format!("session mesh lock task failed: {err}")))?
    .map_err(MeshError::Io)
}

#[cfg(test)]
#[path = "node_tests.rs"]
mod node_tests;
