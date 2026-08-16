//! Machine-local mesh of UnieAI Code sessions.
//!
//! Each CLI process is otherwise an island: the app server runs in-process, so
//! every process owns its own thread manager and cannot see the others. This
//! crate is the discovery and delivery layer that lets sessions on one machine
//! find each other and hand work across.
//!
//! # Shape
//!
//! The shared SQLite state database is the authoritative store — registry rows,
//! message bodies, and the work queue all live there. The per-session Unix
//! socket carries only a doorbell (`"message <id> is waiting for you"`) and a
//! liveness probe. Keeping bodies off the wire makes the protocol small enough
//! that version skew between two differently-versioned CLIs is nearly
//! impossible to get wrong, and it means a message survives a failed delivery.
//!
//! Liveness is *connecting to the socket*, not a timestamp. There is no
//! heartbeat: steady-state cost is one insert at join and one delete at leave,
//! which keeps N concurrent sessions off a shared write-ahead log.
//!
//! # Trust
//!
//! Same-uid plus a 0700 directory and a 0600 socket is the floor, and it is not
//! a security boundary — a hostile process running as you can already read your
//! credentials. The threat this crate actually defends against is a *legitimate*
//! peer whose model has been steered by hostile content it just read. That is
//! handled by consent (the feature flag), rate limiting, hop limits, size caps,
//! and provenance labelling — not by file modes.

mod client;
mod config;
mod error;
mod identity;
mod inbound;
mod node;
mod server;
mod spawn;
mod store;
pub mod wire;

pub use config::MeshConfig;
pub use config::PROTOCOL_VERSION_MAX;
pub use config::PROTOCOL_VERSION_MIN;
pub use config::SOCKET_DIR_NAME;
pub use config::thread_id_from_socket_path;
pub use error::MeshError;
pub use identity::LocalSessionIdentity;
pub use identity::PeerHandle;
pub use identity::PeerSelector;
pub use identity::PeerStatus;
pub use identity::SHORT_REF_MIN_LEN;
pub use identity::SelectorForm;
pub use identity::resolve_peer;
pub use identity::short_ref_display_len;
pub use identity::short_ref_for;
pub use inbound::InboundDecision;
pub use inbound::InboundFuture;
pub use inbound::InboundMessage;
pub use inbound::LocalSnapshot;
pub use inbound::MeshInbound;
pub use node::MeshNode;
pub use node::MeshSender;
pub use spawn::SPAWN_ID_ENV;
pub use spawn::SPAWN_PARENT_ENV;
pub use spawn::SpawnChildParams;
pub use spawn::SpawnedChild;
pub use store::MeshStore;
pub use store::StateRuntimeStore;
pub use store::StoreFuture;
