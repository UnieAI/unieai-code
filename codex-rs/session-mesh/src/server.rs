//! Inbound half of the doorbell protocol.
//!
//! This is the code that lets another process start a turn in your session, so
//! every branch here is a policy decision. The order is deliberate: identify
//! the caller, then check the limits, and only then hand anything to the
//! session. A message that fails any check is *answered*, never dropped — the
//! sender's model has to learn what happened or it will keep trying.

use std::sync::Arc;

use codex_protocol::ThreadId;
use codex_uds::UnixListener;
use codex_uds::UnixStream;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::sync::Semaphore;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use tracing::warn;

use crate::client::read_line_capped;
use crate::config::MeshConfig;
use crate::config::PROTOCOL_VERSION_MAX;
use crate::config::PROTOCOL_VERSION_MIN;
use crate::error::MeshError;
use crate::identity::PeerHandle;
use crate::identity::PeerStatus;
use crate::identity::short_ref_for;
use crate::inbound::InboundDecision;
use crate::inbound::InboundMessage;
use crate::inbound::MeshInbound;
use crate::store::MeshStore;
use crate::wire::Ack;
use crate::wire::Body;
use crate::wire::Delivery;
use crate::wire::Envelope;
use crate::wire::ErrorCode;
use crate::wire::HelloOk;
use crate::wire::ProbeOk;
use crate::wire::WireError;
use crate::wire::negotiate_version;

/// Everything a connection handler needs, shared across accepts.
pub(crate) struct ServerContext {
    pub(crate) config: MeshConfig,
    pub(crate) local_thread_id: ThreadId,
    pub(crate) cli_version: String,
    pub(crate) store: Arc<dyn MeshStore>,
    pub(crate) inbound: Arc<dyn MeshInbound>,
    /// The uid this socket serves. Connections from anyone else are refused.
    pub(crate) local_uid: u32,
}

/// Accepts connections until cancelled.
pub(crate) async fn run_acceptor(
    mut listener: UnixListener,
    context: Arc<ServerContext>,
    shutdown: CancellationToken,
) {
    // Bounded so a peer cannot exhaust memory or file descriptors by opening
    // connections faster than they are served.
    let permits = Arc::new(Semaphore::new(context.config.max_inbound_connections));

    loop {
        let stream = tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(stream) => stream,
                Err(err) => {
                    warn!("session mesh accept failed: {err}");
                    continue;
                }
            },
        };

        let Ok(permit) = Arc::clone(&permits).try_acquire_owned() else {
            // Refusing out loud beats queueing an unbounded number of
            // turn-starting messages.
            tokio::spawn(refuse_busy(stream, Arc::clone(&context)));
            continue;
        };

        // Verified before anything is read from the connection. File modes say
        // who could have reached the socket; this says who did, as attested by
        // the kernel. A platform that cannot answer is refused rather than
        // trusted, which is also why the mesh is Unix-only for now.
        match stream.peer_uid() {
            Ok(uid) if uid == context.local_uid => {}
            Ok(uid) => {
                warn!(
                    "session mesh refused a connection from uid {uid}; this socket serves uid {} only",
                    context.local_uid
                );
                continue;
            }
            Err(err) => {
                warn!("session mesh refused a connection with unverifiable credentials: {err}");
                continue;
            }
        }

        let context = Arc::clone(&context);
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(err) = serve_connection(stream, context).await {
                debug!("session mesh connection ended: {err}");
            }
        });
    }
}

async fn refuse_busy(stream: UnixStream, context: Arc<ServerContext>) {
    let mut reader = BufReader::new(stream);
    let frame = Envelope::new(
        PROTOCOL_VERSION_MAX,
        Body::Error(WireError {
            code: ErrorCode::Busy,
            message: format!(
                "session mesh is serving {} connections",
                context.config.max_inbound_connections
            ),
            v_min: None,
            v_max: None,
        }),
    );
    let _ = write_frame(&mut reader, &frame).await;
}

async fn serve_connection(
    stream: UnixStream,
    context: Arc<ServerContext>,
) -> Result<(), MeshError> {
    let mut reader = BufReader::new(stream);

    let hello_frame = read_frame(
        &mut reader,
        context.config.max_frame_bytes,
        context.config.handshake_timeout,
    )
    .await?;

    let Body::Hello(hello) = hello_frame.body else {
        write_frame(
            &mut reader,
            &Envelope::new(
                PROTOCOL_VERSION_MAX,
                Body::Error(WireError {
                    code: ErrorCode::UnsupportedOp,
                    message: "expected a hello frame".to_string(),
                    v_min: None,
                    v_max: None,
                }),
            ),
        )
        .await?;
        return Err(MeshError::Wire("peer skipped the handshake".to_string()));
    };

    let Some(version) = negotiate_version(
        PROTOCOL_VERSION_MIN,
        PROTOCOL_VERSION_MAX,
        hello.v_min,
        hello.v_max,
    ) else {
        // Reported with both ranges so the operator sees the skew rather than a
        // bare failure.
        write_frame(
            &mut reader,
            &Envelope::new(
                PROTOCOL_VERSION_MAX,
                Body::Error(WireError {
                    code: ErrorCode::VersionUnsupported,
                    message: format!(
                        "no shared protocol version (peer cli {})",
                        hello.cli_version
                    ),
                    v_min: Some(PROTOCOL_VERSION_MIN),
                    v_max: Some(PROTOCOL_VERSION_MAX),
                }),
            ),
        )
        .await?;
        return Err(MeshError::Wire(format!(
            "peer speaks v{}..=v{} which does not overlap v{PROTOCOL_VERSION_MIN}..=v{PROTOCOL_VERSION_MAX}",
            hello.v_min, hello.v_max
        )));
    };

    write_frame(
        &mut reader,
        &Envelope::new(
            version,
            Body::HelloOk(HelloOk {
                v_chosen: version,
                cli_version: context.cli_version.clone(),
            }),
        ),
    )
    .await?;

    // Strictly one request in flight per connection: no pipelining, so a peer
    // cannot queue up turn starts behind a single accept.
    loop {
        let frame = match read_frame(
            &mut reader,
            context.config.max_frame_bytes,
            context.config.request_timeout,
        )
        .await
        {
            Ok(frame) => frame,
            // A peer that hangs up between requests is normal, not an error.
            Err(_) => return Ok(()),
        };

        let response = match frame.body {
            Body::Doorbell(doorbell) => {
                handle_doorbell(&context, &doorbell.message_id, &hello.cli_version).await
            }
            Body::Probe => {
                let snapshot = context.inbound.on_probe().await;
                Body::ProbeOk(ProbeOk {
                    status: snapshot.status,
                    cli_version: snapshot.cli_version,
                })
            }
            // An operation this build does not implement is refused explicitly.
            // The alternative — failing to parse and closing — is exactly the
            // silent-drop failure this protocol is designed to avoid.
            Body::Unknown => Body::Error(WireError {
                code: ErrorCode::UnsupportedOp,
                message: format!(
                    "unsupported operation (this build speaks v{PROTOCOL_VERSION_MIN}..=v{PROTOCOL_VERSION_MAX}, peer cli {})",
                    hello.cli_version
                ),
                v_min: Some(PROTOCOL_VERSION_MIN),
                v_max: Some(PROTOCOL_VERSION_MAX),
            }),
            other => Body::Error(WireError {
                code: ErrorCode::UnsupportedOp,
                message: format!("unexpected frame {other:?}"),
                v_min: None,
                v_max: None,
            }),
        };

        write_frame(&mut reader, &Envelope::new(version, response)).await?;
    }
}

/// Resolves, checks, and delivers one doorbell.
async fn handle_doorbell(
    context: &ServerContext,
    message_id: &str,
    peer_cli_version: &str,
) -> Body {
    let message = match context.store.get_message(message_id).await {
        Ok(Some(message)) => message,
        Ok(None) => {
            return error_body(
                ErrorCode::NotFound,
                format!("no message {message_id} is waiting here"),
            );
        }
        Err(err) => return error_body(ErrorCode::Internal, err.to_string()),
    };

    // A doorbell naming someone else's message must not deliver it here, or a
    // peer could replay any message id it can guess.
    if message.to_thread_id != context.local_thread_id {
        return error_body(
            ErrorCode::NotFound,
            format!("message {message_id} is not addressed to this session"),
        );
    }

    if message.content.len() > context.config.max_content_bytes {
        return reject(
            context,
            message_id,
            ErrorCode::TooLarge,
            format!(
                "message body is {} bytes, limit is {}",
                message.content.len(),
                context.config.max_content_bytes
            ),
        )
        .await;
    }

    if message.hop >= context.config.max_hops {
        // Two sessions replying to each other would otherwise burn tokens in
        // both terminals with nobody watching.
        return reject(
            context,
            message_id,
            ErrorCode::HopLimit,
            format!(
                "message has been relayed {} times, limit is {}",
                message.hop, context.config.max_hops
            ),
        )
        .await;
    }

    // Rate limiting downgrades rather than drops: the message still arrives,
    // it just does not get to start a turn.
    let mut trigger_turn = message.trigger_turn;
    let mut rate_limited = false;
    if trigger_turn {
        let since_ms =
            now_ms().saturating_sub(context.config.trigger_turn_min_interval.as_millis() as i64);
        match context
            .store
            .count_recent_triggers(message.from_thread_id, context.local_thread_id, since_ms)
            .await
        {
            Ok(count) if count > 0 => {
                trigger_turn = false;
                rate_limited = true;
            }
            Ok(_) => {}
            Err(err) => return error_body(ErrorCode::Internal, err.to_string()),
        }
    }

    // Looked up rather than synthesised from the thread id alone: the
    // provenance banner exists to tell the reader *who* sent this, and a handle
    // with no name degrades to the generic fallback, which answers nothing.
    let from = sender_handle(context, message.from_thread_id).await;

    let decision = context
        .inbound
        .on_message(
            from,
            InboundMessage {
                message_id: message.message_id.clone(),
                content: message.content.clone(),
                trigger_turn,
                hop: message.hop,
            },
        )
        .await;

    match decision {
        InboundDecision::Accepted { delivery } => {
            record_delivery(context, message_id, delivery.as_str()).await;
            Body::Ack(Ack {
                accepted: true,
                delivery,
                reject_reason: rate_limited.then(|| {
                    format!(
                        "downgraded to queue-only: at most one turn start per {:?} from this peer",
                        context.config.trigger_turn_min_interval
                    )
                }),
            })
        }
        InboundDecision::Rejected { reason } => {
            record_delivery(context, message_id, &format!("rejected:{reason}")).await;
            debug!("session mesh rejected a message from peer cli {peer_cli_version}: {reason}");
            Body::Ack(Ack {
                accepted: false,
                delivery: Delivery::Rejected,
                reject_reason: Some(reason),
            })
        }
    }
}

/// Builds the sender's handle from the registry.
///
/// Falls back to a bare short ref only when the sender has already left, which
/// is itself information worth showing.
async fn sender_handle(context: &ServerContext, from_thread_id: ThreadId) -> PeerHandle {
    let registered = context
        .store
        .list_peers()
        .await
        .ok()
        .and_then(|peers| {
            peers
                .into_iter()
                .find(|peer| peer.peer.thread_id == from_thread_id)
        });

    match registered {
        Some(row) => PeerHandle {
            thread_id: from_thread_id,
            short_ref: row.peer.short_ref,
            display_name: row.display_name,
            cwd: std::path::PathBuf::from(row.peer.cwd),
            status: PeerStatus::Unknown,
        },
        None => PeerHandle {
            thread_id: from_thread_id,
            short_ref: short_ref_for(from_thread_id),
            display_name: None,
            cwd: std::path::PathBuf::new(),
            status: PeerStatus::Unknown,
        },
    }
}

async fn reject(
    context: &ServerContext,
    message_id: &str,
    code: ErrorCode,
    message: String,
) -> Body {
    record_delivery(context, message_id, &format!("rejected:{message}")).await;
    error_body(code, message)
}

/// Recording the outcome is best-effort: a storage hiccup must not turn a
/// delivered message into a failed one from the sender's point of view.
async fn record_delivery(context: &ServerContext, message_id: &str, delivery: &str) {
    if let Err(err) = context
        .store
        .mark_delivered(message_id, now_ms(), delivery)
        .await
    {
        warn!("failed to record session mesh delivery for {message_id}: {err}");
    }
}

fn error_body(code: ErrorCode, message: String) -> Body {
    Body::Error(WireError {
        code,
        message,
        v_min: None,
        v_max: None,
    })
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

async fn read_frame(
    reader: &mut BufReader<UnixStream>,
    max_frame_bytes: usize,
    within: std::time::Duration,
) -> Result<Envelope, MeshError> {
    let line = timeout(within, read_line_capped(reader, max_frame_bytes))
        .await
        .map_err(|_| MeshError::Wire("timed out waiting for a peer frame".to_string()))??;
    Envelope::from_line(&line)
        .map_err(|err| MeshError::Wire(format!("failed to decode peer frame: {err}")))
}

async fn write_frame(
    reader: &mut BufReader<UnixStream>,
    envelope: &Envelope,
) -> Result<(), MeshError> {
    let line = envelope
        .to_line()
        .map_err(|err| MeshError::Wire(format!("failed to encode frame: {err}")))?;
    reader.get_mut().write_all(line.as_bytes()).await?;
    reader.get_mut().flush().await?;
    Ok(())
}
