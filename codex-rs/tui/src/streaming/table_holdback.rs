//! Pipe-table holdback scanner for source-backed agent streams.
//!
//! Agent streams with markdown tables keep the active table as mutable tail so
//! adding a row can reflow earlier table rows instead of committing a stale
//! render to scrollback.
//!
//! The scanner is intentionally conservative: it only looks for enough
//! structure to decide where the mutable tail should start. It does not try to
//! validate an entire table or predict final layout. Rendering remains the job
//! of the markdown renderer.

use std::time::Instant;

use crate::table_detect::FenceKind;
use crate::table_detect::FenceTracker;
use crate::table_detect::is_table_delimiter_line;
use crate::table_detect::is_table_header_line;
use crate::table_detect::parse_table_segments;
use crate::table_detect::strip_blockquote_prefix;

/// Result of scanning accumulated raw source for pipe-table patterns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TableHoldbackState {
    /// No table detected -- all rendered lines can flow into the stable queue.
    None,
    /// The last non-blank line looks like a table header row but no delimiter
    /// row has followed yet. Hold back in case the next delta is a delimiter.
    PendingHeader { header_start: usize },
    /// A header + delimiter pair was found -- the source contains a confirmed
    /// table. Content from the table header onward stays mutable.
    Confirmed { table_start: usize },
}

/// Facts remembered about the previous committed source line.
///
/// The scanner only needs one-line lookbehind because a table is confirmed by
/// a header row immediately followed by a delimiter row.
#[derive(Clone, Copy)]
struct PreviousLineState {
    source_start: usize,
    fence_kind: FenceKind,
    is_header: bool,
}

/// Incremental scanner for table holdback state on append-only source streams.
///
/// `push_source_chunk` must receive source in the same order it will be
/// appended to the stream. The scanner stores byte offsets into that logical
/// source buffer, so feeding chunks out of order would make later tail
/// boundaries point at the wrong rendered region.
pub(super) struct TableHoldbackScanner {
    source_offset: usize,
    fence_tracker: FenceTracker,
    previous_line: Option<PreviousLineState>,
    pending_header_start: Option<usize>,
    confirmed_table_start: Option<usize>,
}

impl TableHoldbackScanner {
    pub(super) fn new() -> Self {
        Self {
            source_offset: 0,
            fence_tracker: FenceTracker::new(),
            previous_line: None,
            pending_header_start: None,
            confirmed_table_start: None,
        }
    }

    pub(super) fn reset(&mut self) {
        *self = Self::new();
    }

    /// Return the current holdback decision for the committed source prefix.
    ///
    /// `PendingHeader` means the newest non-blank line looks like a table
    /// header but the delimiter row has not arrived yet, so callers should
    /// optimistically keep that region mutable. `Confirmed` means the header
    /// and delimiter pair has been seen and all subsequent body rows remain in
    /// the live tail until finalization.
    pub(super) fn state(&self) -> TableHoldbackState {
        if let Some(table_start) = self.confirmed_table_start {
            TableHoldbackState::Confirmed { table_start }
        } else if let Some(header_start) = self.pending_header_start {
            TableHoldbackState::PendingHeader { header_start }
        } else {
            TableHoldbackState::None
        }
    }

    /// Advance the scanner with newly committed source.
    ///
    /// Chunks are expected to contain only source that is now safe to commit
    /// into `raw_source`, typically newline-terminated lines from the
    /// streaming collector. Partial rows are intentionally excluded so the
    /// scanner never treats an unfinished table row as a stable structural
    /// signal.
    pub(super) fn push_source_chunk(&mut self, source_chunk: &str) {
        if source_chunk.is_empty() {
            return;
        }

        let scan_start = Instant::now();
        let mut lines = 0usize;
        for source_line in source_chunk.split_inclusive('\n') {
            lines += 1;
            self.push_line(source_line);
        }
        tracing::trace!(
            bytes = source_chunk.len(),
            lines,
            state = ?self.state(),
            elapsed_us = scan_start.elapsed().as_micros(),
            "table holdback incremental scan",
        );
    }

    /// Fold one committed source line into the scanner state machine.
    fn push_line(&mut self, source_line: &str) {
        let line = source_line.strip_suffix('\n').unwrap_or(source_line);
        let source_start = self.source_offset;
        let fence_kind = self.fence_tracker.kind();

        let candidate_text = if fence_kind == FenceKind::Other {
            None
        } else {
            table_candidate_text(line)
        };
        let is_header = candidate_text.is_some_and(is_table_header_line);
        let is_delimiter = candidate_text.is_some_and(is_table_delimiter_line);

        if self.confirmed_table_start.is_none()
            && let Some(previous_line) = self.previous_line
            && previous_line.fence_kind != FenceKind::Other
            && fence_kind != FenceKind::Other
            && previous_line.is_header
            && is_delimiter
        {
            self.confirmed_table_start = Some(previous_line.source_start);
            self.pending_header_start = None;
        }

        // A confirmed table ends at the first line that is no longer part of it
        // -- a blank line, or a line without pipe-table structure. Closing the
        // table out matters because the tail budget spans from `table_start` to
        // the end of the render: leaving it confirmed keeps every later line
        // mutable for the rest of the message, so anything past the viewport
        // stays hidden until the stream finalizes.
        if self.confirmed_table_start.is_some() && candidate_text.is_none() {
            self.confirmed_table_start = None;
        }

        if self.confirmed_table_start.is_none() && !line.trim().is_empty() {
            if fence_kind != FenceKind::Other && is_header {
                self.pending_header_start = Some(source_start);
            } else {
                self.pending_header_start = None;
            }
        }

        self.previous_line = Some(PreviousLineState {
            source_start,
            fence_kind,
            is_header,
        });

        self.fence_tracker.advance(line);
        self.source_offset = self.source_offset.saturating_add(source_line.len());
    }
}

/// Strip blockquote prefixes and return the trimmed text if it contains
/// pipe-table segments, or `None` otherwise.
///
/// Table holdback treats quoted tables as real tables, but it still requires a
/// pipe-table shape after the quote markers are removed.
fn table_candidate_text(line: &str) -> Option<&str> {
    let stripped = strip_blockquote_prefix(line).trim();
    parse_table_segments(stripped).map(|_| stripped)
}

/// A source line annotated with whether it falls inside a fenced code block.
#[cfg(test)]
struct ParsedLine<'a> {
    text: &'a str,
    fence_context: FenceKind,
    source_start: usize,
}

/// Parse source into lines tagged with fenced-code context for table scanning.
#[cfg(test)]
fn parse_lines_with_fence_state(source: &str) -> Vec<ParsedLine<'_>> {
    let mut tracker = FenceTracker::new();
    let mut lines = Vec::new();
    let mut source_start = 0usize;

    // Split the same way `push_line` does. `split('\n')` would append a phantom
    // empty line for newline-terminated source, and that line reads as "not a
    // table row", which would close a table the incremental scanner still holds
    // open.
    for raw_line in source.split_inclusive('\n') {
        let text = raw_line.strip_suffix('\n').unwrap_or(raw_line);
        lines.push(ParsedLine {
            text,
            fence_context: tracker.kind(),
            source_start,
        });

        tracker.advance(text);
        source_start = source_start.saturating_add(raw_line.len());
    }

    lines
}

/// Scan `source` for pipe-table patterns outside of non-markdown fenced code
/// blocks.
#[cfg(test)]
pub(super) fn table_holdback_state(source: &str) -> TableHoldbackState {
    let lines = parse_lines_with_fence_state(source);
    let mut confirmed_table_start: Option<usize> = None;
    let mut pending_header_start: Option<usize> = None;
    let mut previous_header_start: Option<usize> = None;

    for line in &lines {
        let candidate_text = if line.fence_context == FenceKind::Other {
            None
        } else {
            table_candidate_text(line.text)
        };
        let is_header = candidate_text.is_some_and(is_table_header_line);
        let is_delimiter = candidate_text.is_some_and(is_table_delimiter_line);

        if confirmed_table_start.is_none()
            && is_delimiter
            && let Some(header_start) = previous_header_start
        {
            confirmed_table_start = Some(header_start);
            pending_header_start = None;
        }

        // A confirmed table stays open only while its rows keep arriving; the
        // first blank or non-pipe line closes it. See `push_line` for why the
        // table must not stay confirmed to the end of the message.
        if confirmed_table_start.is_some() && candidate_text.is_none() {
            confirmed_table_start = None;
        }

        if confirmed_table_start.is_none() && !line.text.trim().is_empty() {
            pending_header_start = is_header.then_some(line.source_start);
        }

        previous_header_start = is_header.then_some(line.source_start);
    }

    if let Some(table_start) = confirmed_table_start {
        TableHoldbackState::Confirmed { table_start }
    } else if let Some(header_start) = pending_header_start {
        TableHoldbackState::PendingHeader { header_start }
    } else {
        TableHoldbackState::None
    }
}
