//! Paste / image "chips" embedded in the composer text.
//!
//! A large paste collapses to a `[Pasted N lines]` placeholder and a pasted
//! image to `[Image #N]`; each is an atomic element occupying a byte [`range`]
//! in the displayed composer text while carrying the full content it stands for.
//! The correctness concern the spec calls out is **keeping those ranges accurate
//! as the surrounding text is edited** — an insertion or deletion before a chip
//! must slide its range, and an edit that lands *inside* a chip invalidates it
//! (a chip is atomic; you can't half-edit it). At submission time the chips
//! [`expand`] back into their full text.
//!
//! This module is the **pure model** for that: placeholder rendering, range
//! shifting under edits, and expansion. It holds no reference to the codex TUI's
//! `TextArea`; a later wiring layer owns the actual widget and calls into here.
//! [`range`]: Chip::range
#![allow(dead_code)]

use std::ops::Range;

/// What a chip stands in for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChipKind {
    /// A collapsed multi-line paste of `lines` lines.
    Paste { lines: usize },
    /// A pasted image, the `n`-th in this composer.
    Image { n: usize },
}

impl ChipKind {
    /// The collapsed placeholder text shown inline in the composer.
    pub(crate) fn placeholder(&self) -> String {
        match *self {
            ChipKind::Paste { lines } => {
                let noun = if lines == 1 { "line" } else { "lines" };
                format!("[Pasted {lines} {noun}]")
            }
            ChipKind::Image { n } => format!("[Image #{n}]"),
        }
    }
}

/// One chip: its kind, the byte range its placeholder occupies in the display
/// text, and the full content it expands to on submission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Chip {
    pub(crate) kind: ChipKind,
    pub(crate) range: Range<usize>,
    /// The full text this chip expands to (the raw paste body, or an image
    /// reference / marker). Substituted for the placeholder at submit time.
    pub(crate) content: String,
}

impl Chip {
    /// A paste chip occupying `range`, standing for `content` (`lines` lines).
    pub(crate) fn paste(range: Range<usize>, lines: usize, content: impl Into<String>) -> Self {
        Self {
            kind: ChipKind::Paste { lines },
            range,
            content: content.into(),
        }
    }

    /// An image chip occupying `range`, the `n`-th image, standing for
    /// `content` (e.g. a file path or attachment marker).
    pub(crate) fn image(range: Range<usize>, n: usize, content: impl Into<String>) -> Self {
        Self {
            kind: ChipKind::Image { n },
            range,
            content: content.into(),
        }
    }

    /// The inline placeholder for this chip.
    pub(crate) fn placeholder(&self) -> String {
        self.kind.placeholder()
    }
}

/// The result of applying a text edit to a single chip's range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ShiftOutcome {
    /// The chip survives, with a (possibly moved) range.
    Kept(Chip),
    /// The edit touched the chip's interior; the chip is no longer atomic and
    /// is dropped.
    Invalidated,
}

/// Apply a text edit — at byte offset `at`, removing `removed` bytes and
/// inserting `inserted` bytes — to a single chip's range.
///
/// * Edit entirely **before** the chip (`at + removed <= start`): the range
///   slides by the signed delta `inserted - removed`.
/// * Edit entirely **after** the chip (`at >= end`): the range is unchanged.
/// * Edit **overlapping** the chip interior: the chip is [`Invalidated`], since
///   a chip is atomic and cannot be partially edited.
///
/// A pure insertion (`removed == 0`) exactly at `start` counts as "before" and
/// pushes the chip right; one exactly at `end` counts as "after" and leaves it
/// put.
///
/// [`Invalidated`]: ShiftOutcome::Invalidated
pub(crate) fn shift_chip(chip: &Chip, at: usize, removed: usize, inserted: usize) -> ShiftOutcome {
    let edit_end = at + removed;
    let Range { start, end } = chip.range;

    if edit_end <= start {
        // Wholly before the chip: slide by the signed delta.
        let new_start = (start + inserted).saturating_sub(removed);
        let new_end = (end + inserted).saturating_sub(removed);
        ShiftOutcome::Kept(Chip {
            range: new_start..new_end,
            ..chip.clone()
        })
    } else if at >= end {
        // Wholly after the chip: unchanged.
        ShiftOutcome::Kept(chip.clone())
    } else {
        // Overlaps the chip interior: no longer atomic.
        ShiftOutcome::Invalidated
    }
}

/// Apply an edit to every chip in `chips` in place, dropping any that the edit
/// invalidated. Chip order is preserved.
pub(crate) fn shift_all(chips: &mut Vec<Chip>, at: usize, removed: usize, inserted: usize) {
    chips.retain_mut(|chip| match shift_chip(chip, at, removed, inserted) {
        ShiftOutcome::Kept(shifted) => {
            *chip = shifted;
            true
        }
        ShiftOutcome::Invalidated => false,
    });
}

/// Expand `display_text` for submission: replace each chip's placeholder range
/// with the chip's full content.
///
/// Chips may be given in any order; they are processed left-to-right by range
/// start. Ranges are assumed non-overlapping (the shifting model preserves
/// that). Any chip whose range falls outside `display_text` is skipped
/// defensively rather than panicking.
pub(crate) fn expand(display_text: &str, chips: &[Chip]) -> String {
    let mut ordered: Vec<&Chip> = chips.iter().collect();
    ordered.sort_by_key(|c| c.range.start);

    let mut out = String::with_capacity(display_text.len());
    let mut cursor = 0usize;
    for chip in ordered {
        let Range { start, end } = chip.range;
        if start < cursor
            || end > display_text.len()
            || start > end
            || !display_text.is_char_boundary(start)
            || !display_text.is_char_boundary(end)
        {
            // Overlapping, reversed, out-of-bounds, or mid-multibyte range:
            // skip defensively — slicing on a non-char boundary would panic.
            continue;
        }
        out.push_str(&display_text[cursor..start]);
        out.push_str(&chip.content);
        cursor = end;
    }
    out.push_str(&display_text[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_text_and_pluralization() {
        assert_eq!(ChipKind::Paste { lines: 12 }.placeholder(), "[Pasted 12 lines]");
        assert_eq!(ChipKind::Paste { lines: 1 }.placeholder(), "[Pasted 1 line]");
        assert_eq!(ChipKind::Image { n: 3 }.placeholder(), "[Image #3]");
    }

    fn chip_at(start: usize, len: usize) -> Chip {
        Chip::paste(start..start + len, 5, "the full pasted body")
    }

    #[test]
    fn insert_before_shifts_chip_right() {
        let chip = chip_at(10, 8); // range 10..18
        // Insert 3 bytes at offset 4 (before the chip).
        let out = shift_chip(&chip, 4, 0, 3);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(13, 8)));
    }

    #[test]
    fn delete_before_shifts_chip_left() {
        let chip = chip_at(10, 8); // 10..18
        // Delete 4 bytes at offset 2 (region 2..6, before the chip).
        let out = shift_chip(&chip, 2, 4, 0);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(6, 8)));
    }

    #[test]
    fn replace_before_applies_signed_delta() {
        let chip = chip_at(10, 8); // 10..18
        // Replace 2 bytes with 5 at offset 3: delta +3.
        let out = shift_chip(&chip, 3, 2, 5);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(13, 8)));
    }

    #[test]
    fn edit_after_leaves_chip_unchanged() {
        let chip = chip_at(10, 8); // 10..18
        let out = shift_chip(&chip, 20, 3, 1);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(10, 8)));
        // Edit exactly at the end boundary is "after".
        let out = shift_chip(&chip, 18, 0, 4);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(10, 8)));
    }

    #[test]
    fn insert_at_start_boundary_pushes_chip() {
        let chip = chip_at(10, 8); // 10..18
        // Pure insertion exactly at start counts as "before".
        let out = shift_chip(&chip, 10, 0, 2);
        assert_eq!(out, ShiftOutcome::Kept(chip_at(12, 8)));
    }

    #[test]
    fn edit_inside_invalidates_chip() {
        let chip = chip_at(10, 8); // 10..18
        // Deletion straddling the interior.
        assert_eq!(shift_chip(&chip, 12, 2, 0), ShiftOutcome::Invalidated);
        // Insertion strictly inside.
        assert_eq!(shift_chip(&chip, 14, 0, 1), ShiftOutcome::Invalidated);
        // Edit starting before but reaching into the chip.
        assert_eq!(shift_chip(&chip, 8, 5, 0), ShiftOutcome::Invalidated);
    }

    #[test]
    fn shift_all_moves_survivors_and_drops_invalidated() {
        let mut chips = vec![chip_at(10, 8), chip_at(30, 8)];
        // Insert 5 bytes at offset 0: both slide right by 5.
        shift_all(&mut chips, 0, 0, 5);
        assert_eq!(chips, vec![chip_at(15, 8), chip_at(35, 8)]);

        // Now delete 1 byte at offset 16: that lands inside the first chip
        // (15..23) so it drops, while the second chip (35..43) is wholly after
        // the edit and slides left by 1 to 34..42.
        shift_all(&mut chips, 16, 1, 0);
        assert_eq!(chips, vec![chip_at(34, 8)]);
    }

    #[test]
    fn expand_replaces_placeholders_with_content() {
        // "hi [Pasted 5 lines] bye" — the placeholder spans bytes 3..21.
        let display = "hi [Pasted 5 lines] bye";
        let ph = "[Pasted 5 lines]";
        let start = display.find(ph).unwrap();
        let chip = Chip::paste(start..start + ph.len(), 5, "line1\nline2\nline3\nline4\nline5");
        let out = expand(display, &[chip]);
        assert_eq!(out, "hi line1\nline2\nline3\nline4\nline5 bye");
    }

    #[test]
    fn expand_handles_multiple_chips_in_any_order() {
        let display = "[Image #1] and [Image #2]";
        let a_start = 0;
        let a = Chip::image(a_start..a_start + "[Image #1]".len(), 1, "<img1>");
        let b_start = display.find("[Image #2]").unwrap();
        let b = Chip::image(b_start..b_start + "[Image #2]".len(), 2, "<img2>");
        // Pass them out of order; expand sorts by range.
        let out = expand(display, &[b, a]);
        assert_eq!(out, "<img1> and <img2>");
    }

    #[test]
    fn expand_with_no_chips_is_identity() {
        assert_eq!(expand("plain text", &[]), "plain text");
    }

    #[test]
    fn expand_skips_mid_multibyte_range_instead_of_panicking() {
        // "日" is 3 bytes; a range starting inside it must be skipped, not panic.
        let text = "日本語 rest";
        let bad = Chip::paste(1..4, 2, "PASTE");
        let out = expand(text, &[bad]);
        assert_eq!(out, text, "invalid chip is ignored, text unchanged");
    }
}
