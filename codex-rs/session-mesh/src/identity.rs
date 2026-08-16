//! Naming and addressing for peer sessions.
//!
//! A peer is addressed as `name [shortref]`, for example `api [k2f8]`. Neither
//! half is sufficient alone: names are user-chosen and collide freely across a
//! machine, and a bare hash is unreadable. The pair is what a human can type
//! and what the model is told to echo back.
//!
//! Ambiguity is always a hard error. Everywhere else a wrong guess produces a
//! wrong list; here it starts a turn in the wrong session, spending tokens and
//! possibly editing a different repository. A "most recently active" tiebreak
//! would misfire exactly when the user has two similar sessions open — the only
//! case where it would ever run.

use std::path::PathBuf;

use codex_protocol::ThreadId;

use crate::error::MeshError;

/// Crockford base32: no `I`, `L`, `O`, or `U`, so a short ref cannot be
/// misread or mistyped into a different one.
const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Bits of the thread id folded into a short ref.
const SHORT_REF_BITS: u32 = 40;
/// `SHORT_REF_BITS / 5`, one character per 5 bits.
const SHORT_REF_LEN: usize = 8;
/// Shortest prefix ever displayed or accepted. Below this, collisions stop
/// being rare enough to treat as exceptional.
pub const SHORT_REF_MIN_LEN: usize = 4;

/// What a session publishes about itself when it joins the mesh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSessionIdentity {
    pub thread_id: ThreadId,
    pub cwd: PathBuf,
    pub session_source: String,
    pub cli_version: String,
    /// Set when this session was launched by another one. The launcher minted
    /// the value and is polling the registry for it, because a child's thread
    /// id does not exist until the child builds its own session.
    pub spawn_id: Option<String>,
    /// The session that launched this one, so completion can be reported back.
    pub spawned_by: Option<ThreadId>,
}

/// Coarse state of a peer, as reported by the peer itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerStatus {
    /// No turn running; a delivered message will start one.
    Idle,
    /// A turn is running; a delivered message waits for the next boundary.
    Working,
    /// Reachable but declined to say more.
    Unknown,
}

impl PeerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Unknown => "unknown",
        }
    }
}

/// A live peer, as seen by the local session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerHandle {
    pub thread_id: ThreadId,
    /// Full 8-character short ref. Display may shorten it; matching never
    /// shortens the stored value.
    pub short_ref: String,
    /// Human-chosen name, from `threads.name`. `None` when the session has
    /// never been named.
    pub display_name: Option<String>,
    pub cwd: PathBuf,
    pub status: PeerStatus,
}

impl PeerHandle {
    /// Name used for matching and display, falling back to the working
    /// directory's basename so an unnamed session is still addressable.
    pub fn name(&self) -> String {
        if let Some(display_name) = self.display_name.as_ref()
            && !display_name.trim().is_empty()
        {
            return slugify(display_name);
        }
        self.cwd
            .file_name()
            .and_then(|name| name.to_str())
            .map(slugify)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "session".to_string())
    }

    /// Renders `name [ref]` with the short ref truncated to `short_ref_len`.
    pub fn display_handle(&self, short_ref_len: usize) -> String {
        let len = short_ref_len.clamp(SHORT_REF_MIN_LEN, SHORT_REF_LEN);
        format!("{} [{}]", self.name(), &self.short_ref[..len])
    }
}

/// Derives a peer's short ref from its thread id.
///
/// Folds the low [`SHORT_REF_BITS`] of the UUID, which for UUIDv7 are random,
/// so short refs of concurrently live sessions differ with high probability.
pub fn short_ref_for(thread_id: ThreadId) -> String {
    let hex: String = thread_id
        .to_string()
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect();
    let tail_start = hex.len().saturating_sub(SHORT_REF_BITS as usize / 4);
    let value = u64::from_str_radix(&hex[tail_start..], 16).unwrap_or(0);

    (0..SHORT_REF_LEN)
        .map(|index| {
            let shift = SHORT_REF_BITS - 5 * (index as u32 + 1);
            let digit = (value >> shift) & 0b11111;
            CROCKFORD_ALPHABET[digit as usize] as char
        })
        .collect()
}

/// Shortest prefix length at which every candidate's short ref is distinct.
///
/// One length is chosen for the whole listing rather than a minimal prefix per
/// peer, so the ref a user reads in one row is the ref they can type for any
/// row.
pub fn short_ref_display_len(peers: &[PeerHandle]) -> usize {
    (SHORT_REF_MIN_LEN..SHORT_REF_LEN)
        .find(|len| {
            let mut prefixes: Vec<&str> =
                peers.iter().map(|peer| &peer.short_ref[..*len]).collect();
            prefixes.sort_unstable();
            let before = prefixes.len();
            prefixes.dedup();
            prefixes.len() == before
        })
        .unwrap_or(SHORT_REF_LEN)
}

/// How a selector string was interpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorForm {
    /// A full thread UUID. Accepted as an escape hatch, never displayed.
    ThreadId(ThreadId),
    /// `name [ref]`. Both halves must point at the same peer.
    NameAndRef { name: String, short_ref: String },
    /// A bare short-ref prefix.
    ShortRef(String),
    /// A bare name.
    Name(String),
}

/// A peer selector as typed by a human or emitted by a model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSelector(String);

impl PeerSelector {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into().trim().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Classifies the selector without consulting any peer list.
    pub fn form(&self) -> SelectorForm {
        if let Ok(thread_id) = ThreadId::from_string(&self.0) {
            return SelectorForm::ThreadId(thread_id);
        }

        if let Some((name, rest)) = self.0.split_once('[')
            && let Some(short_ref) = rest.strip_suffix(']')
        {
            return SelectorForm::NameAndRef {
                name: slugify(name.trim()),
                short_ref: short_ref.trim().to_ascii_lowercase(),
            };
        }

        let candidate = self.0.to_ascii_lowercase();
        if candidate.len() >= SHORT_REF_MIN_LEN
            && candidate.len() <= SHORT_REF_LEN
            && candidate
                .bytes()
                .all(|byte| CROCKFORD_ALPHABET.contains(&byte))
        {
            return SelectorForm::ShortRef(candidate);
        }

        SelectorForm::Name(slugify(&self.0))
    }
}

/// Resolves `selector` against the live peers, refusing to guess.
pub fn resolve_peer(
    selector: &PeerSelector,
    peers: &[PeerHandle],
) -> Result<PeerHandle, MeshError> {
    let matches: Vec<&PeerHandle> = match selector.form() {
        SelectorForm::ThreadId(thread_id) => peers
            .iter()
            .filter(|peer| peer.thread_id == thread_id)
            .collect(),
        SelectorForm::NameAndRef { name, short_ref } => peers
            .iter()
            .filter(|peer| peer.name() == name && peer.short_ref.starts_with(&short_ref))
            .collect(),
        SelectorForm::ShortRef(short_ref) => peers
            .iter()
            .filter(|peer| peer.short_ref.starts_with(&short_ref))
            .collect(),
        SelectorForm::Name(name) => peers.iter().filter(|peer| peer.name() == name).collect(),
    };

    match matches.as_slice() {
        [] => Err(MeshError::PeerNotFound {
            selector: selector.as_str().to_string(),
        }),
        [peer] => Ok((*peer).clone()),
        candidates => Err(MeshError::PeerAmbiguous(render_ambiguity(
            selector, candidates,
        ))),
    }
}

/// Builds the disambiguation message a human or model reads after an ambiguous
/// selector. It must be actionable on its own: every candidate is listed in the
/// exact form that would resolve.
fn render_ambiguity(selector: &PeerSelector, candidates: &[&PeerHandle]) -> String {
    let owned: Vec<PeerHandle> = candidates.iter().map(|peer| (*peer).clone()).collect();
    let short_ref_len = short_ref_display_len(&owned);

    let mut message = format!(
        "`target` \"{}\" matched {} sessions:\n",
        selector.as_str(),
        candidates.len()
    );
    for peer in &owned {
        message.push_str(&format!(
            "  {}  {}  {}\n",
            peer.display_handle(short_ref_len),
            peer.cwd.display(),
            peer.status.as_str()
        ));
    }
    let example = owned
        .first()
        .map(|peer| peer.display_handle(short_ref_len))
        .unwrap_or_default();
    message.push_str(&format!(
        "Re-run with the bracketed form, e.g. target=\"{example}\"."
    ));
    message
}

/// Lowercases and collapses a label into the `[a-z0-9_-]` set so that names
/// typed with different punctuation still compare equal.
fn slugify(value: &str) -> String {
    let mut slug = String::with_capacity(value.len());
    let mut last_was_separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_separator = false;
        } else if !slug.is_empty() && !last_was_separator {
            slug.push('-');
            last_was_separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod identity_tests;
