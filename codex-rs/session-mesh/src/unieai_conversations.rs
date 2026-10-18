// Copyright (c) 2026 UnieAI. All rights reserved.
//! Conversations a session on this machine started, so the answer to them
//! is not held for approval.
//!
//! The hold rule ([`crate::unieai_permissions`]) stops a more restricted
//! session from getting a less restricted one to act for it. A reply to a
//! question the recipient asked itself is not that: the recipient started the
//! exchange, and holding the answer only leaves it waiting for a reply its
//! user must click through.
//!
//! "The recipient started it" is decided from what this process saw itself
//! send, never from anything the sender claims: a message only counts as the
//! start of a conversation when it left through [`crate::MeshSender`] in this
//! process, unprompted by a peer (hop 0). It is bounded three ways:
//!
//! * only messages from the session that was addressed;
//! * only within [`REPLY_WINDOW`] of the opening message;
//! * only below the recipient's hop limit, so a long automatic exchange falls
//!   back to the ordinary rule.
//!
//! A conversation the *peer* started never qualifies, even after this session
//! has replied to it: replies go out at hop 1 or more and are not recorded.
//! A session whose sending side lives in another process (a TUI talking to a
//! separate daemon) has nothing recorded and keeps the ordinary rule.

use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use codex_protocol::ThreadId;

/// How long after its opening message a conversation still counts as live.
pub(crate) const REPLY_WINDOW: Duration = Duration::from_secs(30 * 60);

/// Opening messages sent from this process, by (starter, addressee).
static STARTED: LazyLock<Mutex<HashMap<(ThreadId, ThreadId), Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Records that `from` sent `to` a message at `hop`. Only an unprompted
/// message (hop 0) starts a conversation.
pub(crate) fn note_sent(from: ThreadId, to: ThreadId, hop: u32) {
    if hop != 0 {
        return;
    }
    let mut started = STARTED.lock().unwrap_or_else(PoisonError::into_inner);
    started.retain(|_, at| at.elapsed() <= REPLY_WINDOW);
    started.insert((from, to), Instant::now());
}

/// Whether a message from `peer` at `hop` answers a conversation `local`
/// started with it and that is still live.
pub(crate) fn is_reply_to_started(
    local: ThreadId,
    peer: ThreadId,
    hop: u32,
    max_hops: u32,
) -> bool {
    hop >= 1
        && hop < max_hops
        && STARTED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(local, peer))
            .is_some_and(|at| at.elapsed() <= REPLY_WINDOW)
}

#[cfg(test)]
#[path = "unieai_conversations_tests.rs"]
mod unieai_conversations_tests;
