// Copyright (c) 2026 UnieAI. All rights reserved.
//! Stopping two sessions from talking to each other forever.
//!
//! Two guards, both keyed to "has a user said anything since":
//!
//! * **Hops.** A message carries how many automatic relays it has been through.
//!   When a peer's message reaches this session at hop `h`, what this session
//!   sends back to that peer goes out at `h + 1`, and so does anything it
//!   sends to a third session shortly after ([`RELAY_WINDOW`]): that is the
//!   same request being passed on. The recipient stops starting turns for
//!   messages at or beyond its hop limit, so an A→B→A→B exchange that no human
//!   is watching ends after a few rounds.
//! * **Consecutive automatic turns.** However hops are counted, one peer may
//!   start at most a fixed number of turns here in a row without a user
//!   taking part. Beyond that its messages still arrive, but only as queued
//!   input for the next turn the user starts.
//!
//! Both are bookkeeping for one *exchange*, not for the life of the session.
//! A session that answers questions for others is rarely typed into, and when
//! the counts lived until its user spoke they kept growing across unrelated
//! conversations: after a few, every answer it sent went out at the hop limit
//! and arrived without starting a turn, so the asker never read it. An
//! exchange ends when
//!
//! * this session's user submits input (everything resets);
//! * a peer that counts hops (a UnieAI Code session) writes at hop 0, which it
//!   only does when nothing a peer said is behind the message — its own user
//!   asked, so that peer's counts start over; or
//! * it goes quiet for [`EXCHANGE_IDLE`]: a loop is fast, and a counter that
//!   only an hour-old conversation is keeping high protects nothing.
//!
//! Separately, turn starts from one peer are *paced*: a peer's next turn
//! start waits until a minimum gap has passed since its last one. Pacing is
//! not a budget, so user input does not reset it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use codex_protocol::ThreadId;

/// Default cap on consecutive turns one peer may start without user input.
pub const DEFAULT_MAX_AUTO_TURNS_PER_PEER: u32 = 5;

/// How long after a peer's message something this session sends to a
/// *different* peer still counts as passing that message on.
pub const RELAY_WINDOW: Duration = Duration::from_secs(2 * 60);

/// How long an exchange with a peer may go quiet before its counts are
/// forgotten.
pub const EXCHANGE_IDLE: Duration = Duration::from_secs(15 * 60);

/// Engines whose sessions stamp real hop counts. A hop-0 message from one of
/// them means its own user (or its own initiative) started the exchange. Other
/// senders (the `unieai peers mcp` bridge) always say 0, so their hop-0
/// messages start nothing over.
const HOP_COUNTING_ENGINES: [&str; 2] = ["codex", "uac"];

/// Whether messages from a sender on `engine` carry trustworthy hop counts.
pub fn sender_counts_hops(engine: Option<&str>) -> bool {
    engine.is_some_and(|engine| HOP_COUNTING_ENGINES.contains(&engine.trim()))
}

#[derive(Debug, Clone, Copy)]
struct Seen {
    value: u32,
    at: Instant,
}

impl Seen {
    fn live(self, window: Duration) -> Option<u32> {
        (self.at.elapsed() <= window).then_some(self.value)
    }
}

#[derive(Debug, Default)]
struct ChainState {
    /// Highest hop among messages delivered from each peer in the current
    /// exchange with it.
    inbound_hops: HashMap<ThreadId, Seen>,
    /// Turns each peer has started here in the current exchange.
    auto_turns: HashMap<ThreadId, Seen>,
    /// When each peer last started a turn here.
    last_turn_started: HashMap<ThreadId, Instant>,
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
        state.inbound_hops.clear();
        state.auto_turns.clear();
    }

    /// A message from `from` at `hop` is about to be delivered. A hop-0
    /// message from a session that counts hops opens a new exchange with it.
    pub fn note_arrival(&self, from: ThreadId, hop: u32, sender_counts_hops: bool) {
        if hop == 0 && sender_counts_hops {
            let mut state = self.state();
            state.inbound_hops.remove(&from);
            state.auto_turns.remove(&from);
        }
    }

    /// A message from `from` at `hop` was delivered here.
    pub fn note_delivered(&self, from: ThreadId, hop: u32) {
        let mut state = self.state();
        let previous = state
            .inbound_hops
            .get(&from)
            .and_then(|seen| seen.live(EXCHANGE_IDLE));
        state.inbound_hops.insert(
            from,
            Seen {
                value: previous.map_or(hop, |current| current.max(hop)),
                at: Instant::now(),
            },
        );
    }

    /// Hop to stamp on a message this session sends to `to` now: one further
    /// than the exchange with `to`, or than a message from another peer that
    /// is being passed on.
    pub fn outbound_hop(&self, to: ThreadId) -> u32 {
        let state = self.state();
        state
            .inbound_hops
            .iter()
            .filter_map(|(peer, seen)| {
                let window = if *peer == to {
                    EXCHANGE_IDLE
                } else {
                    RELAY_WINDOW
                };
                seen.live(window)
            })
            .max()
            .map_or(0, |hop| hop.saturating_add(1))
    }

    /// Whether `from` may start another turn here, without recording one.
    pub fn may_start_turn(&self, from: ThreadId) -> bool {
        self.state()
            .auto_turns
            .get(&from)
            .and_then(|seen| seen.live(EXCHANGE_IDLE))
            .unwrap_or(0)
            < self.max_auto_turns_per_peer
    }

    /// Records that `from` started a turn here.
    pub fn note_turn_started(&self, from: ThreadId) {
        let mut state = self.state();
        let count = state
            .auto_turns
            .get(&from)
            .and_then(|seen| seen.live(EXCHANGE_IDLE))
            .unwrap_or(0);
        let now = Instant::now();
        state.auto_turns.insert(
            from,
            Seen {
                value: count.saturating_add(1),
                at: now,
            },
        );
        state.last_turn_started.insert(from, now);
    }

    /// How long a turn start from `from` has to wait so that turn starts from
    /// one peer are at least `min_interval` apart. Zero when it may go now.
    pub fn turn_start_delay(&self, from: ThreadId, min_interval: Duration) -> Duration {
        self.state()
            .last_turn_started
            .get(&from)
            .map_or(Duration::ZERO, |started| {
                min_interval.saturating_sub(started.elapsed())
            })
    }

    pub fn max_auto_turns_per_peer(&self) -> u32 {
        self.max_auto_turns_per_peer
    }

    /// Ages every record by `by`, as if that much time had passed.
    #[cfg(test)]
    pub(crate) fn age_for_test(&self, by: Duration) {
        let mut state = self.state();
        let age = |seen: &mut Seen| {
            seen.at = seen.at.checked_sub(by).unwrap_or(seen.at);
        };
        state.inbound_hops.values_mut().for_each(age);
        state.auto_turns.values_mut().for_each(age);
    }
}

#[cfg(test)]
#[path = "unieai_chain_tests.rs"]
mod unieai_chain_tests;
