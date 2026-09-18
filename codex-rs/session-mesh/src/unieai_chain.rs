// Copyright (c) 2026 UnieAI. All rights reserved.
//! Stopping two sessions from talking to each other forever.
//!
//! Two guards, both keyed to "has this session's user said anything since":
//!
//! * **Hops.** A message carries how many automatic relays it has been through.
//!   When a peer's message reaches this session at hop `h`, anything this
//!   session sends before its user next types goes out at `h + 1`. The
//!   recipient refuses messages at or beyond its hop limit, so an A→B→A→B
//!   exchange that no human is watching ends after a few rounds.
//! * **Consecutive automatic turns.** However hops are counted, one peer may
//!   start at most a fixed number of turns here in a row without this
//!   session's user taking part. Beyond that its messages still arrive, but
//!   only as queued input for the next turn the user starts.
//!
//! Both reset when this session's user submits input: from then on the
//! conversation has a human in it again.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;

use codex_protocol::ThreadId;

/// Default cap on consecutive turns one peer may start without user input.
pub const DEFAULT_MAX_AUTO_TURNS_PER_PEER: u32 = 3;

#[derive(Debug, Default)]
struct ChainState {
    /// Highest hop among messages delivered since the user last spoke.
    inbound_hop: Option<u32>,
    /// Turns each peer has started here since the user last spoke.
    auto_turns: HashMap<ThreadId, u32>,
}

/// Per-session relay bookkeeping. Cheap to share; all methods take `&self`.
#[derive(Debug)]
pub struct PeerChain {
    max_auto_turns_per_peer: u32,
    state: Mutex<ChainState>,
}

impl Default for PeerChain {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_AUTO_TURNS_PER_PEER)
    }
}

impl PeerChain {
    pub fn new(max_auto_turns_per_peer: u32) -> Self {
        Self {
            max_auto_turns_per_peer,
            state: Mutex::new(ChainState::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ChainState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The session's user submitted input: the conversation has a human in it
    /// again.
    pub fn note_user_input(&self) {
        let mut state = self.state();
        state.inbound_hop = None;
        state.auto_turns.clear();
    }

    /// A peer's message at `hop` was delivered here.
    pub fn note_delivered(&self, hop: u32) {
        let mut state = self.state();
        state.inbound_hop = Some(state.inbound_hop.map_or(hop, |current| current.max(hop)));
    }

    /// Hop to stamp on a message this session sends now.
    pub fn outbound_hop(&self) -> u32 {
        self.state()
            .inbound_hop
            .map_or(0, |hop| hop.saturating_add(1))
    }

    /// Whether `from` may start another turn here, without recording one.
    pub fn may_start_turn(&self, from: ThreadId) -> bool {
        self.state().auto_turns.get(&from).copied().unwrap_or(0) < self.max_auto_turns_per_peer
    }

    /// Records that `from` started a turn here.
    pub fn note_turn_started(&self, from: ThreadId) {
        *self.state().auto_turns.entry(from).or_default() += 1;
    }

    pub fn max_auto_turns_per_peer(&self) -> u32 {
        self.max_auto_turns_per_peer
    }
}

#[cfg(test)]
#[path = "unieai_chain_tests.rs"]
mod unieai_chain_tests;
