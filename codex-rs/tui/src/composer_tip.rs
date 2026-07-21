//! TTL teaching tips shown above the composer.
//!
//! A tip is a one-line hint (e.g. "Press Ctrl+P for the command palette"). Per
//! the `tui-composer` spec it behaves deliberately unlike a transient toast:
//!
//! * it does **not** vanish when the user types — only a TTL countdown or an
//!   explicit submit clears it, so a tip stays readable while you work,
//! * once it has been seen `max_seen` times in a session it never shows again.
//!
//! This module is the **pure TTL / seen-count model**. Time is injected as
//! discrete [`tick`](Tip::tick)s (one per frame or per second — the caller
//! decides the unit) so it is deterministic and unit-testable with no clock.
//! Rendering and the actual frame loop are a deferred follow-up.
//!
//! [`tick`]: Tip::tick
#![allow(dead_code)]

/// A teaching tip with a per-session seen cap and a TTL-based lifetime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Tip {
    /// Stable identifier for the tip (dedup / persistence key).
    pub(crate) id: String,
    /// How many times it has been shown this session.
    seen_count: u32,
    /// The per-session cap; at or above this it never shows again.
    max_seen: u32,
    /// TTL in ticks for a single showing.
    ttl: u32,
    /// Remaining ticks while currently visible.
    remaining: u32,
    /// Whether the tip is on screen right now.
    showing: bool,
}

impl Tip {
    /// A tip identified by `id`, shown at most `max_seen` times per session,
    /// each showing lasting `ttl` ticks.
    pub(crate) fn new(id: impl Into<String>, max_seen: u32, ttl: u32) -> Self {
        Self {
            id: id.into(),
            seen_count: 0,
            max_seen,
            ttl,
            remaining: 0,
            showing: false,
        }
    }

    /// Whether the tip is eligible to start showing: not already visible and
    /// under its per-session seen cap.
    pub(crate) fn should_show(&self) -> bool {
        !self.showing && self.seen_count < self.max_seen
    }

    /// Start showing the tip if eligible, resetting its TTL and counting the
    /// showing against the seen cap. Returns whether it started.
    pub(crate) fn show(&mut self) -> bool {
        if !self.should_show() {
            return false;
        }
        self.showing = true;
        self.remaining = self.ttl;
        self.seen_count += 1;
        true
    }

    /// Advance one tick of the injected clock. When the TTL runs out the tip
    /// hides itself. A no-op while hidden.
    ///
    /// Note: typing intentionally does **not** call this — only real time
    /// passing does — which is how a tip survives keystrokes.
    pub(crate) fn tick(&mut self) {
        if !self.showing {
            return;
        }
        self.remaining = self.remaining.saturating_sub(1);
        if self.remaining == 0 {
            self.showing = false;
        }
    }

    /// Clear the tip immediately, e.g. when the user submits the composer.
    pub(crate) fn on_submit(&mut self) {
        self.showing = false;
        self.remaining = 0;
    }

    /// Whether the tip is currently on screen.
    pub(crate) fn is_visible(&self) -> bool {
        self.showing
    }

    /// How many times the tip has been shown this session.
    pub(crate) fn seen_count(&self) -> u32 {
        self.seen_count
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_then_expires_after_ttl() {
        let mut tip = Tip::new("palette", 3, 2);
        assert!(tip.should_show());
        assert!(tip.show());
        assert!(tip.is_visible());

        tip.tick(); // remaining 2 -> 1
        assert!(tip.is_visible());
        tip.tick(); // remaining 1 -> 0, hides
        assert!(!tip.is_visible());
    }

    #[test]
    fn typing_does_not_hide_a_tip() {
        // There is no "on typing" API; only ticks (time) and submit clear a tip.
        // Simulate many keystrokes with zero ticks in between: still visible.
        let mut tip = Tip::new("palette", 3, 5);
        tip.show();
        for _ in 0..100 {
            // (no tick, no submit — modeling keystrokes)
            assert!(tip.is_visible());
        }
    }

    #[test]
    fn submit_clears_the_tip_immediately() {
        let mut tip = Tip::new("palette", 3, 10);
        tip.show();
        assert!(tip.is_visible());
        tip.on_submit();
        assert!(!tip.is_visible());
    }

    #[test]
    fn seen_count_caps_showings_per_session() {
        let mut tip = Tip::new("palette", 2, 1);
        // First showing.
        assert!(tip.show());
        tip.tick(); // expires
        // Second showing.
        assert!(tip.show());
        tip.tick(); // expires
        // Now at the cap: never shows again.
        assert!(!tip.should_show());
        assert!(!tip.show());
        assert_eq!(tip.seen_count(), 2);
    }

    #[test]
    fn cannot_start_while_already_showing() {
        let mut tip = Tip::new("palette", 5, 3);
        assert!(tip.show());
        // A second show() while visible is a no-op and does not burn a seen.
        assert!(!tip.show());
        assert_eq!(tip.seen_count(), 1);
    }
}
