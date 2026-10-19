// Copyright (c) 2026 UnieAI. All rights reserved.
//! Rewinding to an earlier prompt: restore the files too, or the conversation only.

use super::*;
use crate::history_cell::HistoryCell;
use codex_app_server_protocol::ThreadRevertFileChange;
use codex_app_server_protocol::ThreadRevertFileChangeKind;

/// Files named in the menu before the rest is summarized as a count.
const LISTED_FILES: usize = 6;

/// "a.txt (restored), b.txt (deleted) and 3 more".
pub(crate) fn rewind_files_summary(files: &[ThreadRevertFileChange]) -> String {
    let listed = files
        .iter()
        .take(LISTED_FILES)
        .map(|file| {
            let what = match file.change {
                ThreadRevertFileChangeKind::Modify => "restored",
                ThreadRevertFileChangeKind::Delete => "deleted",
                ThreadRevertFileChangeKind::Create => "recreated",
            };
            format!("{} ({what})", file.path)
        })
        .collect::<Vec<_>>()
        .join(", ");
    match files.len().saturating_sub(LISTED_FILES) {
        0 => listed,
        more => format!("{listed} and {more} more"),
    }
}

impl ChatWidget {
    /// Ask whether a rewind to `prompt` also puts back the files later turns changed.
    pub(crate) fn show_rewind_files_menu(
        &mut self,
        thread_id: ThreadId,
        selected_cell: Arc<dyn HistoryCell>,
        prompt: UserMessage,
        files: &[ThreadRevertFileChange],
    ) {
        let choice = |restore_files: bool| -> Vec<SelectionAction> {
            let selected_cell = Arc::clone(&selected_cell);
            let prompt = prompt.clone();
            vec![Box::new(move |tx| {
                tx.send(AppEvent::RevertSessionForPromptEdit {
                    thread_id,
                    selected_cell: Arc::clone(&selected_cell),
                    prompt: prompt.clone(),
                    restore_files: Some(restore_files),
                });
            })]
        };
        let count = files.len();
        let noun = if count == 1 { "file" } else { "files" };
        self.show_selection_view(SelectionViewParams {
            title: Some("Rewind to this message".to_string()),
            subtitle: Some(format!(
                "{count} {noun} changed since then: {}",
                rewind_files_summary(files)
            )),
            footer_hint: Some(standard_popup_hint_line()),
            initial_selected_idx: Some(0),
            items: vec![
                SelectionItem {
                    name: "Restore code and conversation".to_string(),
                    description: Some(format!(
                        "Put the {count} {noun} back, then edit the message"
                    )),
                    actions: choice(true),
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: "Restore conversation only".to_string(),
                    description: Some("Keep the files as they are now".to_string()),
                    actions: choice(false),
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: "Never mind".to_string(),
                    description: Some("Change nothing".to_string()),
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ],
            ..SelectionViewParams::confirmation()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn change(path: &str, change: ThreadRevertFileChangeKind) -> ThreadRevertFileChange {
        ThreadRevertFileChange {
            path: path.to_string(),
            change,
        }
    }

    #[test]
    fn rewind_files_summary_names_each_change_and_counts_the_rest() {
        assert_eq!(
            rewind_files_summary(&[
                change("src/a.rs", ThreadRevertFileChangeKind::Modify),
                change("new.txt", ThreadRevertFileChangeKind::Delete),
                change("gone.txt", ThreadRevertFileChangeKind::Create),
            ]),
            "src/a.rs (restored), new.txt (deleted), gone.txt (recreated)"
        );
        let many: Vec<_> = (0..9)
            .map(|n| change(&format!("f{n}"), ThreadRevertFileChangeKind::Modify))
            .collect();
        assert_eq!(
            rewind_files_summary(&many),
            "f0 (restored), f1 (restored), f2 (restored), f3 (restored), f4 (restored), f5 (restored) and 3 more"
        );
    }
}
