//! Outbound half of the doorbell protocol.

use std::path::Path;

use codex_uds::UnixStream;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::time::timeout;

use crate::config::MeshConfig;
use crate::config::PROTOCOL_VERSION_MAX;
use crate::config::PROTOCOL_VERSION_MIN;
use crate::error::MeshError;
use crate::wire::Ack;
use crate::wire::Body;
use crate::wire::Doorbell;
use crate::wire::Envelope;
use crate::wire::Hello;
use crate::wire::ProbeOk;

/// An open, version-negotiated connection to one peer.
pub struct PeerConnection {
    reader: BufReader<UnixStream>,
    version: u32,
    max_frame_bytes: usize,
    request_timeout: std::time::Duration,
    /// Reported in errors so a bug report reads "peer was 0.48, I am 0.51"
    /// rather than "it didn't work".
    pub peer_cli_version: String,
}

impl PeerConnection {
    /// Connects and completes the handshake.
    ///
    /// Nothing is ever sent optimistically: a version mismatch is discovered
    /// here, before any work is attributed to it.
    pub async fn open(
        config: &MeshConfig,
        socket_path: &Path,
        from_thread_id: &str,
        cli_version: &str,
    ) -> Result<Self, MeshError> {
        let stream = timeout(config.connect_timeout, UnixStream::connect(socket_path))
            .await
            .map_err(|_| {
                MeshError::Wire(format!("timed out connecting to {}", socket_path.display()))
            })??;

        let mut connection = Self {
            reader: BufReader::new(stream),
            version: PROTOCOL_VERSION_MAX,
            max_frame_bytes: config.max_frame_bytes,
            request_timeout: config.request_timeout,
            peer_cli_version: String::new(),
        };

        let hello = Envelope::new(
            PROTOCOL_VERSION_MAX,
            Body::Hello(Hello {
                v_min: PROTOCOL_VERSION_MIN,
                v_max: PROTOCOL_VERSION_MAX,
                from_thread_id: from_thread_id.to_string(),
                cli_version: cli_version.to_string(),
            }),
        );
        connection.write_frame(&hello).await?;

        match connection.read_frame(config.handshake_timeout).await?.body {
            Body::HelloOk(hello_ok) => {
                connection.version = hello_ok.v_chosen;
                connection.peer_cli_version = hello_ok.cli_version;
                Ok(connection)
            }
            Body::Error(error) => Err(MeshError::Wire(format!(
                "peer refused the handshake: {} ({:?}{})",
                error.message,
                error.code,
                match (error.v_min, error.v_max) {
                    (Some(min), Some(max)) => format!(", peer speaks v{min}..=v{max}"),
                    _ => String::new(),
                }
            ))),
            other => Err(MeshError::Wire(format!(
                "peer answered the handshake with {other:?}"
            ))),
        }
    }

    /// Rings the doorbell for an already-stored message and returns what the
    /// peer did with it.
    ///
    /// Never retried: a retried turn-starting message could start two turns.
    pub async fn send_doorbell(
        &mut self,
        message_id: &str,
        from_thread_id: &str,
    ) -> Result<Ack, MeshError> {
        let frame = Envelope::new(
            self.version,
            Body::Doorbell(Doorbell {
                message_id: message_id.to_string(),
                from_thread_id: from_thread_id.to_string(),
            }),
        );
        self.write_frame(&frame).await?;

        match self.read_frame(self.request_timeout).await?.body {
            Body::Ack(ack) => Ok(ack),
            Body::Error(error) => Err(MeshError::Wire(format!(
                "peer refused delivery: {} ({:?}, peer cli {})",
                error.message, error.code, self.peer_cli_version
            ))),
            other => Err(MeshError::Wire(format!(
                "peer answered a doorbell with {other:?}"
            ))),
        }
    }

    /// Asks the peer what it is doing right now.
    pub async fn probe(&mut self) -> Result<ProbeOk, MeshError> {
        self.write_frame(&Envelope::new(self.version, Body::Probe))
            .await?;

        match self.read_frame(self.request_timeout).await?.body {
            Body::ProbeOk(probe) => Ok(probe),
            Body::Error(error) => Err(MeshError::Wire(format!(
                "peer refused a probe: {} ({:?})",
                error.message, error.code
            ))),
            other => Err(MeshError::Wire(format!(
                "peer answered a probe with {other:?}"
            ))),
        }
    }

    async fn write_frame(&mut self, envelope: &Envelope) -> Result<(), MeshError> {
        let line = envelope
            .to_line()
            .map_err(|err| MeshError::Wire(format!("failed to encode frame: {err}")))?;
        self.reader.get_mut().write_all(line.as_bytes()).await?;
        self.reader.get_mut().flush().await?;
        Ok(())
    }

    async fn read_frame(&mut self, within: std::time::Duration) -> Result<Envelope, MeshError> {
        let line = timeout(
            within,
            read_line_capped(&mut self.reader, self.max_frame_bytes),
        )
        .await
        .map_err(|_| MeshError::Wire("timed out waiting for a peer response".to_string()))??;
        Envelope::from_line(&line)
            .map_err(|err| MeshError::Wire(format!("failed to decode peer frame: {err}")))
    }
}

/// Reads one newline-delimited frame, refusing to grow past `max_bytes`.
///
/// `read_line` would happily allocate whatever a peer sends; a same-uid peer is
/// not trusted enough for that.
pub(crate) async fn read_line_capped<R>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
) -> Result<String, MeshError>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Err(MeshError::Wire("peer closed the connection".to_string()));
            }
            break;
        }

        match available.iter().position(|byte| *byte == b'\n') {
            Some(newline) => {
                line.extend_from_slice(&available[..=newline]);
                reader.consume(newline + 1);
                break;
            }
            None => {
                let consumed = available.len();
                line.extend_from_slice(available);
                reader.consume(consumed);
            }
        }

        if line.len() > max_bytes {
            return Err(MeshError::Wire(format!(
                "peer frame exceeded {max_bytes} bytes"
            )));
        }
    }

    String::from_utf8(line)
        .map_err(|err| MeshError::Wire(format!("peer frame was not utf-8: {err}")))
}
