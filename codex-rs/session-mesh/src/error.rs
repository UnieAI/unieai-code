use std::path::PathBuf;

use thiserror::Error;

/// Why a mesh operation could not be completed.
///
/// The variants are deliberately specific about *absent infrastructure* versus
/// *nobody there*: a caller must be able to tell "the mesh is unavailable on
/// this host" from "the mesh is up and you have no peers", because those read
/// identically as an empty list and only one of them is a bug.
#[derive(Debug, Error)]
pub enum MeshError {
    /// The local state database is not available, so there is nowhere to
    /// publish or read the registry.
    #[error("session mesh unavailable: local state database is not initialized")]
    RegistryUnavailable,

    /// The mesh is not supported on this platform.
    #[error("session mesh unavailable: {reason}")]
    Unsupported { reason: String },

    /// Another live process already owns this session's socket path.
    #[error("session mesh socket is already owned by another process: {path}")]
    SocketOwned { path: PathBuf },

    /// The selector matched no live peer.
    #[error("no such peer: {selector}")]
    PeerNotFound { selector: String },

    /// The selector matched more than one live peer.
    ///
    /// Carries the rendered candidate list because guessing is not an option
    /// here: a wrong guess starts a turn in the wrong session.
    #[error("{0}")]
    PeerAmbiguous(String),

    #[error("session mesh io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("session mesh wire error: {0}")]
    Wire(String),
}
