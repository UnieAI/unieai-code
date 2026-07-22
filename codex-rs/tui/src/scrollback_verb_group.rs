//! Verb-group aggregation for the scrollback.
//!
//! A burst of consecutive **non-destructive** tool calls (reads, searches,
//! directory listings, web lookups, subagents, MCP tools) folds into a single
//! live summary line — e.g. `Read 3 files, Searched 2 patterns · 1 failed`.
//! The line re-aggregates every frame so it can flip verb tense the moment the
//! last call finishes and grow its counts as new calls stream in.
//!
//! This module is the **pure, self-contained** core of that feature: it owns
//! the tool-name classifier ([`classify_tool`]), the bucket vocabulary
//! ([`VerbGroupKind`]: verb tense + noun pluralization), and the accumulator
//! ([`VerbGroupAccumulator`]) that turns a sequence of [`ToolEvent`]s into the
//! aggregated [`VerbGroupLabel`]. It deliberately depends on *no* codex TUI
//! internal types, so it compiles and unit-tests in isolation; the rendering
//! layer feeds it plain [`ToolEvent`] values built from whatever history model
//! is in play.
//!
//! Logic translated (not copied) from grok-build's
//! `scrollback/state/verb_group.rs` — `run_step` (classification),
//! `BucketAccumulator::into_label` (bucketing / pluralization / tense / failure
//! suffix), and the citation-URL / child-session-id source de-dup.
//!
//! Live wiring: the transcript already folds a run of consecutive
//! non-destructive exec calls (read / list / search) into one exploring
//! `ExecCell` at insert time (`ExecCell::add_call`), and commits that cell to
//! terminal scrollback exactly once, when the run breaks. This module supplies
//! the aggregated header for that fold: `exec_cell::render` builds
//! [`ToolEvent`]s from the cell's parsed commands and renders [`aggregate`]'s
//! label ("Read 3 files, Searched 2 patterns · 1 failed") as the group header
//! when [`verb_groups_enabled`] and the run has at least
//! [`VERB_GROUP_FOLD_THRESHOLD`] calls.
//!
//! Staging note: the exec-side wiring exercises the Read/ReadSkill/Search/
//! ListDir buckets and the accumulator. The name-based [`classify_tool`]
//! classifier and the WebSearch/WebFetch/Subagent/McpTool buckets are staged
//! for the follow-up that folds runs of MCP / web-search *cells* (a
//! different insert seam); they keep the module-level dead-code opt-out.
#![allow(dead_code)]

/// Minimum number of calls in a fold before the verb-group summary header
/// replaces the plain "Explored" header (matches the panel's threshold).
pub(crate) const VERB_GROUP_FOLD_THRESHOLD: usize = 3;

/// Environment variables (in priority order) gating the verb-group summary
/// header. Mirrors the `*_FORCE_COLOR_LEVEL` naming convention.
const VERB_GROUPS_ENV_VARS: [&str; 2] = ["UNIEAI_TUI_VERB_GROUPS", "CODEX_TUI_VERB_GROUPS"];

static VERB_GROUPS_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn verb_groups_enabled_from_env() -> bool {
    VERB_GROUPS_ENV_VARS
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .map(|v| matches!(v.trim(), "1" | "true" | "on" | "yes"))
        // Default OFF: a `tui.verb_groups` config key belongs in codex-core's
        // Config (alongside `tui.theme`), which is outside this change's file
        // scope; until that lands the env gate is the only opt-in, and OFF
        // keeps every existing exploring-header snapshot byte-identical.
        .unwrap_or(false)
}

/// Detect and pin the process-wide gate. Called once at TUI startup.
pub(crate) fn init_verb_groups_enabled() -> bool {
    *VERB_GROUPS_ENABLED.get_or_init(verb_groups_enabled_from_env)
}

/// The pinned gate value; defaults to OFF when `init_verb_groups_enabled`
/// has not run (notably in unit tests, which pass the flag explicitly).
pub(crate) fn verb_groups_enabled() -> bool {
    VERB_GROUPS_ENABLED.get().copied().unwrap_or(false)
}

/// The kind of a tool call, for verb-group bucketing.
///
/// Each kind carries its own verb (present-tense while the run is live,
/// past-tense once every member has finished) and noun (singular / plural by
/// count). Buckets appear in the aggregated label in first-appearance order;
/// two events with the same kind share a bucket.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub(crate) enum VerbGroupKind {
    /// Reading an ordinary file (`Read N files`).
    Read,
    /// Reading a skill definition — a separate bucket from ordinary files so a
    /// `SKILL.md` read never inflates the file count (`Read N skills`).
    ReadSkill,
    /// A code/text pattern search — grep-like (`Searched N patterns`).
    Search,
    /// A directory listing (`Listed N dirs`).
    ListDir,
    /// A web search; counts distinct citation websites, not calls
    /// (`Searched N websites`).
    WebSearch,
    /// Fetching a single web page / URL (`Fetched N pages`).
    WebFetch,
    /// A subagent lifecycle row; counts distinct child sessions
    /// (`Ran N subagents`).
    Subagent,
    /// An MCP / custom tool invocation (`Ran N tools`).
    McpTool,
    /// A shell command execution (`Ran N commands`). Destructive-agnostic:
    /// excluded from live verb-group folds, but nameable in truncation labels.
    Execute,
    /// A file edit / patch (`Edited N files`). Destructive: never joins a live
    /// verb-group fold, but nameable in truncation labels.
    Edit,
}

impl VerbGroupKind {
    /// The verb for this kind, tense chosen by whether the run is still live.
    pub(crate) fn verb(self, running: bool) -> &'static str {
        match self {
            VerbGroupKind::Read | VerbGroupKind::ReadSkill => {
                if running {
                    "Reading"
                } else {
                    "Read"
                }
            }
            VerbGroupKind::Search | VerbGroupKind::WebSearch => {
                if running {
                    "Searching"
                } else {
                    "Searched"
                }
            }
            VerbGroupKind::ListDir => {
                if running {
                    "Listing"
                } else {
                    "Listed"
                }
            }
            VerbGroupKind::WebFetch => {
                if running {
                    "Fetching"
                } else {
                    "Fetched"
                }
            }
            VerbGroupKind::Subagent | VerbGroupKind::McpTool | VerbGroupKind::Execute => {
                if running {
                    "Running"
                } else {
                    "Ran"
                }
            }
            VerbGroupKind::Edit => {
                if running {
                    "Editing"
                } else {
                    "Edited"
                }
            }
        }
    }

    /// The noun for this kind, pluralized by `count`.
    pub(crate) fn noun(self, count: usize) -> &'static str {
        let plural = count != 1;
        match self {
            VerbGroupKind::Read | VerbGroupKind::Edit => {
                if plural {
                    "files"
                } else {
                    "file"
                }
            }
            VerbGroupKind::ReadSkill => {
                if plural {
                    "skills"
                } else {
                    "skill"
                }
            }
            VerbGroupKind::Search => {
                if plural {
                    "patterns"
                } else {
                    "pattern"
                }
            }
            VerbGroupKind::ListDir => {
                if plural {
                    "dirs"
                } else {
                    "dir"
                }
            }
            VerbGroupKind::WebSearch => {
                if plural {
                    "websites"
                } else {
                    "website"
                }
            }
            VerbGroupKind::WebFetch => {
                if plural {
                    "pages"
                } else {
                    "page"
                }
            }
            VerbGroupKind::Subagent => {
                if plural {
                    "subagents"
                } else {
                    "subagent"
                }
            }
            VerbGroupKind::McpTool => {
                if plural {
                    "tools"
                } else {
                    "tool"
                }
            }
            VerbGroupKind::Execute => {
                if plural {
                    "commands"
                } else {
                    "command"
                }
            }
        }
    }

    /// Whether a run of this kind may fold into a **live** verb-group header.
    ///
    /// Non-destructive lookups fold; destructive or side-effecting kinds
    /// (`Execute`, `Edit`) do not — they still get named inside truncation
    /// ("N more") labels, but never collapse a live burst.
    pub(crate) fn folds_in_verb_group(self) -> bool {
        !matches!(self, VerbGroupKind::Execute | VerbGroupKind::Edit)
    }
}

/// One tool call handed to the accumulator.
///
/// The rendering layer builds these from its own history model. `sources` is
/// the distinct-count override: WebSearch pushes its citation URLs, a subagent
/// pushes its child-session-id. When a bucket has collected any sources, their
/// distinct count replaces the raw call count in the label; otherwise the call
/// count is used (the fallback that keeps a still-running / result-less search
/// from showing zero).
#[derive(Clone, Debug)]
pub(crate) struct ToolEvent {
    pub(crate) kind: VerbGroupKind,
    /// This call is still in flight (flips the whole group's verb to present).
    pub(crate) running: bool,
    /// This call finished with an error (feeds the `· N failed` suffix).
    pub(crate) failed: bool,
    /// De-dup keys for the distinct-count override (citation URLs, child
    /// session ids). Empty for kinds that count calls directly.
    pub(crate) sources: Vec<String>,
}

impl ToolEvent {
    /// A plain call with no sources — the common case for reads/searches.
    pub(crate) fn new(kind: VerbGroupKind, running: bool, failed: bool) -> Self {
        Self {
            kind,
            running,
            failed,
            sources: Vec::new(),
        }
    }

    /// A call carrying de-dup source keys (WebSearch citations, subagent id).
    pub(crate) fn with_sources(
        kind: VerbGroupKind,
        running: bool,
        failed: bool,
        sources: Vec<String>,
    ) -> Self {
        Self {
            kind,
            running,
            failed,
            sources,
        }
    }
}

/// Classify a tool by name (and, when available, its primary argument such as
/// the path being read) into a [`VerbGroupKind`].
///
/// Returns `None` for tools with no verb-group vocabulary — the caller keeps
/// them standalone. The matching is intentionally forgiving about casing and
/// the assorted aliases the same logical tool goes by across codex surfaces
/// (`read` / `read_file` / `Read`, `shell` / `exec` / `local_shell`, …); any
/// `mcp__server__tool` name folds into the generic MCP bucket.
pub(crate) fn classify_tool(name: &str, primary_arg: Option<&str>) -> Option<VerbGroupKind> {
    let lower = name.trim().to_ascii_lowercase();

    // MCP tools are namespaced `mcp__server__tool`; bucket them generically.
    if lower.starts_with("mcp__") || lower.starts_with("mcp.") {
        return Some(VerbGroupKind::McpTool);
    }

    match lower.as_str() {
        "read" | "read_file" | "readfile" | "view" | "cat" | "open" => {
            Some(read_kind_for_arg(primary_arg))
        }
        "grep" | "search" | "ripgrep" | "rg" | "code_search" | "grep_search" => {
            Some(VerbGroupKind::Search)
        }
        "list_dir" | "listdir" | "ls" | "list_directory" | "glob" | "find" => {
            Some(VerbGroupKind::ListDir)
        }
        "web_search" | "websearch" | "web.search" | "browser_search" => {
            Some(VerbGroupKind::WebSearch)
        }
        "web_fetch" | "webfetch" | "fetch" | "open_page" | "open_url" | "url_fetch" => {
            Some(VerbGroupKind::WebFetch)
        }
        "task" | "subagent" | "spawn_agent" | "agent" | "delegate" => Some(VerbGroupKind::Subagent),
        "shell" | "exec" | "bash" | "local_shell" | "run" | "command" | "execute" => {
            Some(VerbGroupKind::Execute)
        }
        "edit" | "apply_patch" | "write" | "write_file" | "patch" | "str_replace" | "update" => {
            Some(VerbGroupKind::Edit)
        }
        _ => None,
    }
}

/// A read whose target lives under a `skills/` tree and points at a skill
/// manifest is a `ReadSkill`; anything else is an ordinary `Read`. Keeping the
/// two apart stops a `SKILL.md` read from inflating the visible file count.
pub(crate) fn read_kind_for_arg(primary_arg: Option<&str>) -> VerbGroupKind {
    let looks_like_skill = primary_arg.is_some_and(|path| {
        let lower = path.to_ascii_lowercase();
        (lower.contains("/skills/") || lower.contains("\\skills\\"))
            && (lower.ends_with("skill.md") || lower.ends_with("/skill") || lower.ends_with("skill.yaml"))
    });
    if looks_like_skill {
        VerbGroupKind::ReadSkill
    } else {
        VerbGroupKind::Read
    }
}

/// The aggregated summary produced from a run of [`ToolEvent`]s.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct VerbGroupLabel {
    /// The rendered text, e.g. `Read 3 files, Searched 2 patterns · 1 failed`.
    pub(crate) text: String,
    /// Any member is still running (present tense + live accent while true).
    pub(crate) running: bool,
    /// Any member failed (error accent + the `· N failed` suffix present).
    pub(crate) failed: bool,
    /// How many members failed (0 when none did).
    pub(crate) failed_count: usize,
}

/// One per-kind aggregation bucket, ordered by first appearance in the run.
struct Bucket {
    kind: VerbGroupKind,
    calls: usize,
    /// Distinct de-dup keys; when non-empty, its size is the displayed count.
    sources: std::collections::HashSet<String>,
}

/// Accumulates a sequence of tool events into a single aggregated label.
///
/// The caller owns the *walk* — which events belong to the run and how they're
/// classified. This owns per-kind counting, the distinct-source override,
/// failure counting, tense selection, and the rendered text. Feed events with
/// [`push`](Self::push), then [`into_label`](Self::into_label).
#[derive(Default)]
pub(crate) struct VerbGroupAccumulator {
    buckets: Vec<Bucket>,
    running: bool,
    failed_count: usize,
}

impl VerbGroupAccumulator {
    /// Whether any event has been accumulated.
    pub(crate) fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }

    /// Fold one tool event into its kind's bucket.
    pub(crate) fn push(&mut self, event: &ToolEvent) {
        let pos = match self.buckets.iter().position(|b| b.kind == event.kind) {
            Some(pos) => pos,
            None => {
                self.buckets.push(Bucket {
                    kind: event.kind,
                    calls: 0,
                    sources: std::collections::HashSet::new(),
                });
                self.buckets.len() - 1
            }
        };
        let bucket = &mut self.buckets[pos];
        bucket.calls += 1;
        for source in &event.sources {
            bucket.sources.insert(source.clone());
        }
        if event.failed {
            self.failed_count += 1;
        }
        if event.running {
            self.running = true;
        }
    }

    /// Render the accumulated buckets into the final label. Bucket segments are
    /// joined by `, ` in first-appearance order; a `· N failed` suffix is
    /// appended when any member failed.
    pub(crate) fn into_label(self) -> VerbGroupLabel {
        let mut text = String::new();
        for (i, bucket) in self.buckets.iter().enumerate() {
            let count = if bucket.sources.is_empty() {
                bucket.calls
            } else {
                bucket.sources.len()
            };
            if i > 0 {
                text.push_str(", ");
            }
            text.push_str(bucket.kind.verb(self.running));
            text.push(' ');
            text.push_str(&count.to_string());
            text.push(' ');
            text.push_str(bucket.kind.noun(count));
        }
        if self.failed_count > 0 {
            text.push_str(&format!(" · {} failed", self.failed_count));
        }

        VerbGroupLabel {
            text,
            running: self.running,
            failed: self.failed_count > 0,
            failed_count: self.failed_count,
        }
    }
}

/// Aggregate a run of tool events into one label. Convenience wrapper over
/// [`VerbGroupAccumulator`] for callers that already have the run collected.
pub(crate) fn aggregate(events: &[ToolEvent]) -> VerbGroupLabel {
    let mut acc = VerbGroupAccumulator::default();
    for event in events {
        acc.push(event);
    }
    acc.into_label()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &str) -> ToolEvent {
        ToolEvent::new(read_kind_for_arg(Some(path)), false, false)
    }

    fn plain(kind: VerbGroupKind) -> ToolEvent {
        ToolEvent::new(kind, false, false)
    }

    // --- bucketing + pluralization -------------------------------------

    #[test]
    fn buckets_in_first_appearance_order_with_plurality() {
        let events = vec![
            read("a.rs"),
            plain(VerbGroupKind::Search),
            read("b.rs"),
            plain(VerbGroupKind::ListDir),
        ];
        let l = aggregate(&events);
        assert_eq!(l.text, "Read 2 files, Searched 1 pattern, Listed 1 dir");
        assert!(!l.running);
        assert!(!l.failed);
    }

    #[test]
    fn skill_reads_bucket_separately_from_files() {
        let events = vec![
            read("a.rs"),
            read("/x/skills/deploy/SKILL.md"),
            read("b.rs"),
        ];
        let l = aggregate(&events);
        assert_eq!(l.text, "Read 2 files, Read 1 skill");
    }

    #[test]
    fn singular_uses_singular_noun() {
        let l = aggregate(&[read("only.rs")]);
        assert_eq!(l.text, "Read 1 file");
    }

    // --- tense flip -----------------------------------------------------

    #[test]
    fn running_flips_tense_only() {
        let mut events = vec![read("a.rs"), plain(VerbGroupKind::Search)];
        events[1].running = true;
        let l = aggregate(&events);
        assert_eq!(l.text, "Reading 1 file, Searching 1 pattern");
        assert!(l.running);

        events[1].running = false;
        let l = aggregate(&events);
        assert_eq!(l.text, "Read 1 file, Searched 1 pattern");
        assert!(!l.running);
    }

    #[test]
    fn any_running_member_flips_the_whole_group() {
        let mut events = vec![read("a.rs"), read("b.rs"), read("c.rs")];
        events[2].running = true;
        let l = aggregate(&events);
        assert_eq!(l.text, "Reading 3 files");
        assert!(l.running);
    }

    // --- failed suffix --------------------------------------------------

    #[test]
    fn failed_members_append_suffix_and_flag() {
        let events = vec![
            read("a.rs"),
            ToolEvent::new(VerbGroupKind::Read, false, true),
            ToolEvent::new(VerbGroupKind::Read, false, true),
        ];
        let l = aggregate(&events);
        assert_eq!(l.text, "Read 3 files · 2 failed");
        assert!(l.failed);
        assert_eq!(l.failed_count, 2);
    }

    #[test]
    fn no_failures_no_suffix() {
        let l = aggregate(&[read("a.rs"), read("b.rs")]);
        assert!(!l.text.contains("failed"));
        assert!(!l.failed);
        assert_eq!(l.failed_count, 0);
    }

    // --- source de-dup --------------------------------------------------

    #[test]
    fn web_search_counts_distinct_sources_with_call_fallback() {
        let searched = |citations: &[&str]| {
            ToolEvent::with_sources(
                VerbGroupKind::WebSearch,
                false,
                false,
                citations.iter().map(|s| s.to_string()).collect(),
            )
        };
        // Three distinct URLs across two searches, one duplicated.
        let events = vec![
            searched(&["https://a.com", "https://b.com"]),
            searched(&["https://b.com", "https://c.com"]),
        ];
        let l = aggregate(&events);
        assert_eq!(l.text, "Searched 3 websites");

        // No citations yet (still running / no results): fall back to calls.
        let events = vec![searched(&[]), searched(&[])];
        let l = aggregate(&events);
        assert_eq!(l.text, "Searched 2 websites");
    }

    #[test]
    fn subagent_lifecycle_rows_dedup_by_child_session_id() {
        // started + completed of the same child count once.
        let started = ToolEvent::with_sources(
            VerbGroupKind::Subagent,
            false,
            false,
            vec!["child-A".into()],
        );
        let completed = ToolEvent::with_sources(
            VerbGroupKind::Subagent,
            false,
            false,
            vec!["child-A".into()],
        );
        let l = aggregate(&[read("a.rs"), started, read("b.rs"), completed]);
        assert_eq!(l.text, "Read 2 files, Ran 1 subagent");
        assert!(!l.failed);
    }

    #[test]
    fn subagent_completion_burst_counts_each_distinct_subagent() {
        let done = |id: &str| {
            ToolEvent::with_sources(VerbGroupKind::Subagent, false, false, vec![id.into()])
        };
        let l = aggregate(&[done("child-A"), done("child-B")]);
        assert_eq!(l.text, "Ran 2 subagents");
    }

    #[test]
    fn subagent_failed_feeds_suffix() {
        let failed = ToolEvent::with_sources(
            VerbGroupKind::Subagent,
            false,
            true,
            vec!["child-A".into()],
        );
        let cancelled = ToolEvent::with_sources(
            VerbGroupKind::Subagent,
            false,
            false,
            vec!["child-B".into()],
        );
        let l = aggregate(&[failed, cancelled]);
        assert_eq!(l.text, "Ran 2 subagents · 1 failed");
        assert!(l.failed);
    }

    #[test]
    fn running_subagent_flips_group_tense() {
        let mut started = ToolEvent::with_sources(
            VerbGroupKind::Subagent,
            true,
            false,
            vec!["child-A".into()],
        );
        started.running = true;
        let l = aggregate(&[read("a.rs"), started]);
        assert_eq!(l.text, "Reading 1 file, Running 1 subagent");
        assert!(l.running);
    }

    // --- classifier -----------------------------------------------------

    #[test]
    fn classify_maps_known_tool_names() {
        assert_eq!(classify_tool("read", Some("a.rs")), Some(VerbGroupKind::Read));
        assert_eq!(classify_tool("Read", None), Some(VerbGroupKind::Read));
        assert_eq!(
            classify_tool("read", Some("/x/skills/deploy/SKILL.md")),
            Some(VerbGroupKind::ReadSkill)
        );
        assert_eq!(classify_tool("grep", None), Some(VerbGroupKind::Search));
        assert_eq!(classify_tool("ls", None), Some(VerbGroupKind::ListDir));
        assert_eq!(
            classify_tool("web_search", None),
            Some(VerbGroupKind::WebSearch)
        );
        assert_eq!(classify_tool("fetch", None), Some(VerbGroupKind::WebFetch));
        assert_eq!(classify_tool("task", None), Some(VerbGroupKind::Subagent));
        assert_eq!(classify_tool("shell", None), Some(VerbGroupKind::Execute));
        assert_eq!(
            classify_tool("apply_patch", None),
            Some(VerbGroupKind::Edit)
        );
        assert_eq!(
            classify_tool("mcp__github__list_issues", None),
            Some(VerbGroupKind::McpTool)
        );
        assert_eq!(classify_tool("totally_unknown", None), None);
    }

    #[test]
    fn folds_excludes_destructive_and_shell() {
        assert!(VerbGroupKind::Read.folds_in_verb_group());
        assert!(VerbGroupKind::WebSearch.folds_in_verb_group());
        assert!(VerbGroupKind::Subagent.folds_in_verb_group());
        assert!(!VerbGroupKind::Execute.folds_in_verb_group());
        assert!(!VerbGroupKind::Edit.folds_in_verb_group());
    }

    // --- truncation-style mixed label (Execute/Edit nameable) -----------

    #[test]
    fn mixed_kinds_including_execute_and_edit_render_in_order() {
        let events = vec![
            plain(VerbGroupKind::Execute),
            read("a.rs"),
            plain(VerbGroupKind::Edit),
            plain(VerbGroupKind::Execute),
        ];
        let l = aggregate(&events);
        assert_eq!(l.text, "Ran 2 commands, Read 1 file, Edited 1 file");
    }

    #[test]
    fn empty_run_is_empty_label() {
        let l = aggregate(&[]);
        assert_eq!(l.text, "");
        assert!(!l.running);
        assert!(!l.failed);
    }
}
