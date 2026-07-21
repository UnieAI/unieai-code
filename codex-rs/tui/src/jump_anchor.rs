//! `/jump` navigation: turn list with a live-preview cursor and a width-stable
//! scroll anchor.
//!
//! Inspired by grok-build's `views/jump.rs`. Moving the cursor in `/jump` scrolls
//! the transcript live to the cursor's turn; pressing Esc must restore the
//! viewport the user had *before* they started previewing. The subtlety is that
//! the terminal may have been resized in the meantime, so a restore keyed off a
//! wrapped-**row** offset would drift — a byte/row position that was correct at
//! width W1 points at a different logical line at width W2.
//!
//! The fix, modelled here, is a [`ScrollAnchor`] that captures a **logical**
//! position — `(turn, logical line within turn)` — which is width-independent.
//! [`ScrollAnchor::restore`] re-derives the wrapped-row scroll offset for the
//! current width, landing on the same logical line regardless of resize.
//!
//! This is pure geometry only: no live transcript, no real scrolling, no key
//! handling. Those are DEFERRED.
#![allow(dead_code)]

/// Wrapped-row count for a logical line of `len` display cells at `width`.
/// An empty line still occupies one row; width 0 is treated as 1.
fn rows_for_len(len: usize, width: usize) -> usize {
    let width = width.max(1);
    if len == 0 {
        1
    } else {
        len.div_ceil(width)
    }
}

/// One turn in the transcript: an ordered list of logical lines.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Turn {
    pub(crate) lines: Vec<String>,
}

impl Turn {
    pub(crate) fn new(lines: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            lines: lines.into_iter().map(Into::into).collect(),
        }
    }

    /// Total wrapped rows this turn occupies at `width`. An empty turn (no
    /// lines) still occupies a single row so it remains a scroll target.
    fn wrapped_rows(&self, width: usize) -> usize {
        if self.lines.is_empty() {
            return 1;
        }
        self.lines.iter().map(|l| rows_for_len(l.chars().count(), width)).sum()
    }
}

/// A width-independent scroll position: the turn and the logical line within it
/// that sat at the top of the viewport. Restoring re-wraps at the current width.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ScrollAnchor {
    /// Index of the turn whose content is at the viewport top.
    pub(crate) turn: usize,
    /// Index of the logical line within that turn at the viewport top.
    pub(crate) line: usize,
}

/// The `/jump` model: the transcript turns plus a cursor. The cursor is the
/// turn the live preview scrolls to; [`capture`](Self::capture) /
/// [`restore`](Self::restore) round-trip the pre-jump viewport width-stably.
#[derive(Clone, Debug, Default)]
pub(crate) struct JumpList {
    turns: Vec<Turn>,
    cursor: usize,
}

impl JumpList {
    pub(crate) fn new(turns: Vec<Turn>) -> Self {
        Self { turns, cursor: 0 }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.turns.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.turns.len()
    }

    pub(crate) fn cursor(&self) -> usize {
        self.cursor
    }

    /// Move the cursor up one turn (clamped at the first turn).
    pub(crate) fn move_up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    /// Move the cursor down one turn (clamped at the last turn).
    pub(crate) fn move_down(&mut self) {
        if self.turns.is_empty() {
            return;
        }
        self.cursor = (self.cursor + 1).min(self.turns.len() - 1);
    }

    /// Live-scroll target for the current cursor: the wrapped-row offset of the
    /// top of the cursor's turn at `width`.
    pub(crate) fn scroll_target(&self, width: usize) -> usize {
        self.turn_start_row(self.cursor, width)
    }

    /// The absolute wrapped-row offset of the first row of `turn` at `width`.
    fn turn_start_row(&self, turn: usize, width: usize) -> usize {
        self.turns
            .iter()
            .take(turn.min(self.turns.len()))
            .map(|t| t.wrapped_rows(width))
            .sum()
    }

    /// The absolute wrapped-row offset of a logical `(turn, line)` at `width`.
    fn logical_to_row(&self, anchor: ScrollAnchor, width: usize) -> usize {
        let mut row = self.turn_start_row(anchor.turn, width);
        if let Some(t) = self.turns.get(anchor.turn) {
            for line in t.lines.iter().take(anchor.line) {
                row += rows_for_len(line.chars().count(), width);
            }
        }
        row
    }

    /// Resolve an absolute wrapped-row offset back to the logical `(turn, line)`
    /// whose span contains it, at `width`. Rows past the end clamp to the last
    /// logical line.
    fn row_to_logical(&self, target_row: usize, width: usize) -> ScrollAnchor {
        let mut row = 0usize;
        let mut last = ScrollAnchor { turn: 0, line: 0 };
        for (ti, turn) in self.turns.iter().enumerate() {
            if turn.lines.is_empty() {
                last = ScrollAnchor { turn: ti, line: 0 };
                if target_row < row + 1 {
                    return last;
                }
                row += 1;
                continue;
            }
            for (li, line) in turn.lines.iter().enumerate() {
                last = ScrollAnchor { turn: ti, line: li };
                let h = rows_for_len(line.chars().count(), width);
                if target_row < row + h {
                    return last;
                }
                row += h;
            }
        }
        last
    }

    /// Capture the pre-jump viewport: given the viewport-top wrapped-row offset
    /// and the width it was measured at, store the logical position so it can be
    /// restored width-stably later.
    pub(crate) fn capture(&self, viewport_top_row: usize, width: usize) -> ScrollAnchor {
        self.row_to_logical(viewport_top_row, width)
    }

    /// Restore a captured anchor to a wrapped-row scroll offset at the current
    /// `width`. The returned row lands on the anchor's logical line regardless of
    /// how the width changed since capture.
    pub(crate) fn restore(&self, anchor: ScrollAnchor, width: usize) -> usize {
        self.logical_to_row(anchor, width)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> JumpList {
        // Turn 0: two lines, the first is 30 cells wide.
        // Turn 1: one 45-cell line.
        // Turn 2: a short line.
        JumpList::new(vec![
            Turn::new(vec!["x".repeat(30), "y".repeat(10)]),
            Turn::new(vec!["z".repeat(45)]),
            Turn::new(vec!["short"]),
        ])
    }

    #[test]
    fn rows_for_len_wraps_and_floors_at_one() {
        assert_eq!(rows_for_len(0, 20), 1);
        assert_eq!(rows_for_len(20, 20), 1);
        assert_eq!(rows_for_len(21, 20), 2);
        assert_eq!(rows_for_len(40, 20), 2);
        // width 0 must not divide by zero.
        assert_eq!(rows_for_len(5, 0), 5);
    }

    #[test]
    fn cursor_clamps_and_drives_scroll_target() {
        let mut list = sample();
        assert_eq!(list.cursor(), 0);
        list.move_up();
        assert_eq!(list.cursor(), 0);

        // At width 20: turn 0 = ceil(30/20)+ceil(10/20) = 2 + 1 = 3 rows.
        list.move_down();
        assert_eq!(list.cursor(), 1);
        assert_eq!(list.scroll_target(20), 3);

        list.move_down();
        list.move_down();
        assert_eq!(list.cursor(), 2);
        // turn 0 (3) + turn 1 (ceil(45/20)=3) = 6.
        assert_eq!(list.scroll_target(20), 6);
    }

    #[test]
    fn anchor_restores_to_same_logical_line_across_width_change() {
        let list = sample();
        let w1 = 20;
        let w2 = 50;

        // At width 20 the viewport top sits at row 3 — the start of turn 1.
        let top_row_w1 = 3;
        let anchor = list.capture(top_row_w1, w1);
        assert_eq!(anchor, ScrollAnchor { turn: 1, line: 0 });

        // Restoring under the NEW width lands on the same logical line...
        let restored_w2 = list.restore(anchor, w2);
        // ...but at a different absolute row, proving the byte/row offset drifts:
        // at width 50, turn 0 = 1 + 1 = 2 rows, so turn 1 starts at row 2.
        assert_eq!(restored_w2, 2);
        assert_ne!(restored_w2, top_row_w1);

        // Round-trip: the restored row resolves back to the captured logical pos.
        assert_eq!(list.row_to_logical(restored_w2, w2), anchor);

        // A naive restore that reused the OLD row number (3) at the new width
        // would drift to a different logical line — demonstrating why the anchor
        // is needed.
        let naive = list.row_to_logical(top_row_w1, w2);
        assert_ne!(naive, anchor);
    }

    #[test]
    fn capture_mid_turn_line_is_width_stable() {
        let list = sample();
        // At width 20, turn 0's second line ("y"*10) starts at row 2
        // (first line wraps to 2 rows). Capture there.
        let anchor = list.capture(2, 20);
        assert_eq!(anchor, ScrollAnchor { turn: 0, line: 1 });

        // At width 50 the first line no longer wraps, so the second line starts
        // at row 1. The anchor still points at (turn 0, line 1).
        assert_eq!(list.restore(anchor, 50), 1);
        assert_eq!(list.row_to_logical(1, 50), anchor);
    }

    #[test]
    fn empty_list_is_inert() {
        let mut list = JumpList::new(vec![]);
        assert!(list.is_empty());
        list.move_down();
        list.move_up();
        assert_eq!(list.cursor(), 0);
        assert_eq!(list.scroll_target(20), 0);
    }

    #[test]
    fn row_past_end_clamps_to_last_line() {
        let list = sample();
        let anchor = list.capture(9999, 20);
        assert_eq!(anchor, ScrollAnchor { turn: 2, line: 0 });
    }
}
