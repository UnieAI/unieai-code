// Copyright (c) 2026 UnieAI. All rights reserved.
//! Monitoring what the session has running: `/tasks`, and the agent tree's
//! open and stop.
//!
//! Two kinds of task. A subagent is a thread of its own (the agent picker's
//! threads); a background command is a command an agent left running, which
//! both engines report the way codex's unified exec does — a
//! `commandExecution` item with a `processId` (source `unifiedExecStartup`)
//! when it starts, completed when it exits. [`TaskMonitor`] keeps the
//! commands still running and the model each thread runs on, folded from the
//! notifications every thread delivers.
//!
//! Stopping goes through the protocol both engines answer: `turn/interrupt`
//! on the agent's thread (uac routes a subagent's to dsh's own interrupt) and
//! `thread/backgroundTerminals/terminate` for a command. Opening a command
//! pages its recent output: uac answers `unieai/exec/output`; on the codex
//! engine the footer's last lines for that process stand in.

use std::collections::HashMap;
use std::time::Instant;

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_protocol::CommandExecutionSource;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::RequestId;
use codex_app_server_protocol::ServerNotification;
use codex_app_server_protocol::ThreadItem;
use codex_protocol::ThreadId;
use serde::Deserialize;
use serde_json::json;

use super::App;
use crate::app_event::AppEvent;
use crate::app_server_session::AppServerSession;
use crate::bottom_pane::AgentRow;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::TaskRow;
use crate::bottom_pane::TaskStatus;
use crate::bottom_pane::TreeTarget;
use crate::multi_agents::AgentPickerThreadEntry;
use crate::pager_overlay::Overlay;
use crate::tui;

/// The uac engine's method for a background command's recent output.
pub(crate) const EXEC_OUTPUT_METHOD: &str = "unieai/exec/output";

/// How much of a command's output the pager asks for.
const EXEC_OUTPUT_BYTES: u64 = 64_000;

/// One command an agent left running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecSessionEntry {
    pub(crate) thread_id: ThreadId,
    pub(crate) process_id: String,
    pub(crate) command: String,
    pub(crate) started_at: Instant,
}

/// What the notifications say is running, beyond the threads themselves.
#[derive(Debug, Default)]
pub(crate) struct TaskMonitor {
    exec_sessions: Vec<ExecSessionEntry>,
    models: HashMap<ThreadId, String>,
}

impl TaskMonitor {
    /// Folds one thread's notification in. True when the tree should redraw.
    pub(crate) fn observe(
        &mut self,
        thread_id: ThreadId,
        notification: &ServerNotification,
    ) -> bool {
        match notification {
            ServerNotification::ItemStarted(started) => {
                let Some((process_id, command)) = background_command(&started.item) else {
                    return false;
                };
                if self.exec_session(thread_id, process_id).is_some() {
                    return false;
                }
                self.exec_sessions.push(ExecSessionEntry {
                    thread_id,
                    process_id: process_id.to_string(),
                    command: command.to_string(),
                    started_at: Instant::now(),
                });
                true
            }
            ServerNotification::ItemCompleted(completed) => {
                let Some((process_id, _)) = background_command(&completed.item) else {
                    return false;
                };
                self.forget_exec_session(thread_id, process_id)
            }
            ServerNotification::ThreadStarted(started) => match started.thread.model.as_ref() {
                Some(model) if !model.is_empty() => self.set_model(thread_id, model),
                _ => false,
            },
            ServerNotification::ThreadSettingsUpdated(updated) => {
                let model = &updated.thread_settings.model;
                !model.is_empty() && self.set_model(thread_id, model)
            }
            _ => false,
        }
    }

    fn set_model(&mut self, thread_id: ThreadId, model: &str) -> bool {
        if self.models.get(&thread_id).map(String::as_str) == Some(model) {
            return false;
        }
        self.models.insert(thread_id, model.to_string());
        true
    }

    pub(crate) fn model(&self, thread_id: ThreadId) -> Option<&str> {
        self.models.get(&thread_id).map(String::as_str)
    }

    pub(crate) fn exec_sessions(&self) -> &[ExecSessionEntry] {
        &self.exec_sessions
    }

    pub(crate) fn exec_session(
        &self,
        thread_id: ThreadId,
        process_id: &str,
    ) -> Option<&ExecSessionEntry> {
        self.exec_sessions
            .iter()
            .find(|entry| entry.thread_id == thread_id && entry.process_id == process_id)
    }

    /// Drops a command that ended. True when it was listed.
    pub(crate) fn forget_exec_session(&mut self, thread_id: ThreadId, process_id: &str) -> bool {
        let before = self.exec_sessions.len();
        self.exec_sessions
            .retain(|entry| !(entry.thread_id == thread_id && entry.process_id == process_id));
        self.exec_sessions.len() != before
    }
}

/// A command left running: its process id and command line.
fn background_command(item: &ThreadItem) -> Option<(&str, &str)> {
    match item {
        ThreadItem::CommandExecution {
            command,
            process_id: Some(process_id),
            source: CommandExecutionSource::UnifiedExecStartup,
            ..
        } => Some((process_id.as_str(), command.as_str())),
        _ => None,
    }
}

/// The command as the tree shows it: its first line, without `bash -lc`.
fn command_label(command: &str) -> String {
    let display = crate::exec_command::strip_bash_lc_and_escape(
        &crate::exec_command::split_command_string(command),
    );
    display.lines().next().unwrap_or_default().to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecOutput {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    running: bool,
    #[serde(default)]
    exit_code: Option<i64>,
    #[serde(default)]
    output: String,
}

/// Ask the uac engine for a background command's recent output.
async fn fetch_exec_output(
    request_handle: AppServerRequestHandle,
    thread_id: ThreadId,
    process_id: String,
) -> Result<Vec<String>, String> {
    let AppServerRequestHandle::Remote(handle) = request_handle else {
        return Err("this engine does not page a command's output".to_string());
    };
    let response = handle
        .request_json_rpc(JSONRPCRequest {
            id: RequestId::String(format!("tui-exec-output-{}", uuid::Uuid::new_v4())),
            method: EXEC_OUTPUT_METHOD.to_string(),
            params: Some(json!({
                "threadId": thread_id.to_string(),
                "processId": process_id,
                "maxBytes": EXEC_OUTPUT_BYTES,
            })),
            trace: None,
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.message)?;
    let output: ExecOutput =
        serde_json::from_value(response).map_err(|err| format!("unexpected answer: {err}"))?;
    Ok(exec_output_lines(&output))
}

fn exec_output_lines(output: &ExecOutput) -> Vec<String> {
    let state = if output.running {
        "running".to_string()
    } else {
        match output.exit_code {
            Some(code) => format!("exited {code}"),
            None => "ended".to_string(),
        }
    };
    let mut lines = vec![format!(
        "{} · {state}{}",
        output.command.as_deref().unwrap_or("command"),
        output
            .cwd
            .as_deref()
            .map(|cwd| format!(" · {cwd}"))
            .unwrap_or_default()
    )];
    lines.push(String::new());
    if output.output.is_empty() {
        lines.push("(no output yet)".to_string());
    } else {
        lines.extend(output.output.lines().map(str::to_string));
    }
    lines
}

impl App {
    /// The name a thread goes by in the tree and in `/tasks`.
    pub(super) fn agent_label(
        &self,
        thread_id: ThreadId,
        entry: &AgentPickerThreadEntry,
    ) -> String {
        entry
            .agent_nickname
            .clone()
            .or_else(|| entry.agent_role.clone())
            // A spawned agent is named by its path (`/root/plan`) even
            // when it has no nickname, and that name is what the user
            // asked for — falling straight through to a short ref threw
            // away the one label they chose.
            .or_else(|| {
                entry.agent_path.as_deref().and_then(|path| {
                    path.rsplit('/')
                        .next()
                        .filter(|name| !name.is_empty())
                        .map(str::to_string)
                })
            })
            .unwrap_or_else(|| {
                if Some(thread_id) == self.primary_thread_id {
                    "main".to_string()
                } else {
                    crate::multi_agents::short_thread_label(thread_id)
                }
            })
    }

    /// The model a thread runs on, as far as the notifications said.
    pub(super) fn agent_model(&self, thread_id: ThreadId) -> Option<String> {
        self.tasks.model(thread_id).map(str::to_string).or_else(|| {
            (Some(thread_id) == self.primary_thread_id)
                .then(|| {
                    self.primary_session_configured
                        .as_ref()
                        .map(|session| session.model.clone())
                })
                .flatten()
                .filter(|model| !model.is_empty())
        })
    }

    /// Tree rows for the commands `thread_id` left running.
    pub(super) fn exec_session_tree_rows(&self, thread_id: ThreadId) -> Vec<AgentRow> {
        self.tasks
            .exec_sessions()
            .iter()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| AgentRow {
                target: TreeTarget::ExecSession {
                    thread: entry.thread_id,
                    process_id: entry.process_id.clone(),
                },
                label: command_label(&entry.command),
                activity: None,
                is_running: true,
                is_active: false,
                elapsed: Some(crate::bottom_pane::format_elapsed(
                    entry.started_at.elapsed(),
                )),
                tokens: None,
                model: None,
                context_left_percent: None,
            })
            .collect()
    }

    /// The `/tasks` table: subagents (every thread but the main one) and the
    /// commands any thread left running.
    pub(super) fn task_rows(&mut self) -> Vec<TaskRow> {
        let threads: Vec<(ThreadId, AgentPickerThreadEntry)> = self
            .agent_navigation
            .ordered_threads()
            .into_iter()
            .filter(|(thread_id, _)| Some(*thread_id) != self.primary_thread_id)
            .map(|(thread_id, entry)| (thread_id, entry.clone()))
            .collect();
        let mut rows = Vec::new();
        for (thread_id, entry) in threads {
            let started_at = *self
                .agent_started_at
                .entry(thread_id)
                .or_insert_with(Instant::now);
            let status = if entry.is_running {
                TaskStatus::Running
            } else if entry.is_closed {
                TaskStatus::Done
            } else {
                TaskStatus::Idle
            };
            rows.push(TaskRow {
                target: TreeTarget::Thread(thread_id),
                label: self.agent_label(thread_id, &entry),
                status,
                elapsed: entry
                    .is_running
                    .then(|| crate::bottom_pane::format_elapsed(started_at.elapsed())),
                tokens: self.agent_tokens.get(&thread_id).copied(),
                model: self.agent_model(thread_id),
                detail: self.agent_activity.get(&thread_id).cloned(),
            });
        }
        for entry in self.tasks.exec_sessions() {
            let owner = self
                .agent_navigation
                .get(&entry.thread_id)
                .map(|navigation| self.agent_label(entry.thread_id, navigation))
                .unwrap_or_else(|| {
                    if Some(entry.thread_id) == self.primary_thread_id {
                        "main".to_string()
                    } else {
                        crate::multi_agents::short_thread_label(entry.thread_id)
                    }
                });
            rows.push(TaskRow {
                target: TreeTarget::ExecSession {
                    thread: entry.thread_id,
                    process_id: entry.process_id.clone(),
                },
                label: command_label(&entry.command),
                status: TaskStatus::Running,
                elapsed: Some(crate::bottom_pane::format_elapsed(
                    entry.started_at.elapsed(),
                )),
                tokens: None,
                model: None,
                detail: Some(format!("started by {owner}")),
            });
        }
        rows
    }

    pub(super) fn open_tasks(&mut self) {
        let rows = self.task_rows();
        self.chat_widget.show_tasks(rows);
    }

    /// Asks before stopping: an interrupted agent or a killed command cannot
    /// be taken back.
    pub(super) fn confirm_stop_task(
        &mut self,
        target: TreeTarget,
        label: String,
        reopen_tasks: bool,
    ) {
        self.chat_widget
            .show_selection_view(stop_confirmation_params(target, label, reopen_tasks));
    }

    pub(super) async fn stop_task(
        &mut self,
        app_server: &mut AppServerSession,
        target: TreeTarget,
        reopen_tasks: bool,
    ) {
        match target {
            TreeTarget::Thread(thread_id) => {
                let turn_id = self
                    .active_turn_id_for_thread(thread_id)
                    .await
                    .unwrap_or_default();
                if let Err(error) = app_server.turn_interrupt(thread_id, turn_id).await {
                    self.chat_widget
                        .add_error_message(format!("Failed to stop the agent: {error}"));
                }
            }
            TreeTarget::ExecSession { thread, process_id } => {
                match app_server
                    .thread_background_terminals_terminate(thread, process_id.clone())
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => self.chat_widget.add_info_message(
                        "That command had already ended.".to_string(),
                        /*hint*/ None,
                    ),
                    Err(error) => {
                        self.chat_widget
                            .add_error_message(format!("Failed to stop the command: {error}"));
                        if reopen_tasks {
                            self.open_tasks();
                        }
                        return;
                    }
                }
                // Gone either way; its completion may never arrive if it
                // had already ended.
                if self.tasks.forget_exec_session(thread, &process_id) {
                    self.refresh_agent_tree();
                }
            }
        }
        if reopen_tasks {
            self.open_tasks();
        }
    }

    pub(super) fn open_task(&mut self, app_server: &AppServerSession, target: TreeTarget) {
        match target {
            TreeTarget::Thread(thread_id) => {
                self.app_event_tx
                    .send(AppEvent::SelectAgentThread(thread_id));
            }
            TreeTarget::ExecSession { thread, process_id } => {
                let title = self
                    .tasks
                    .exec_session(thread, &process_id)
                    .map(|entry| format!("$ {}", command_label(&entry.command)))
                    .unwrap_or_else(|| format!("process {process_id}"));
                // The codex engine keeps no output to page; the footer's last
                // lines for the process, when this thread is on screen.
                let fallback = (self.current_displayed_thread_id() == Some(thread))
                    .then(|| self.chat_widget.unified_exec_recent_output(&process_id))
                    .flatten();
                let request_handle = app_server.request_handle();
                let app_event_tx = self.app_event_tx.clone();
                tokio::spawn(async move {
                    let result = match fetch_exec_output(request_handle, thread, process_id).await {
                        Ok(lines) => Ok(lines),
                        Err(error) => match fallback {
                            Some(lines) if !lines.is_empty() => Ok(lines),
                            _ => Err(error),
                        },
                    };
                    app_event_tx.send(AppEvent::TaskOutputLoaded { title, result });
                });
            }
        }
    }

    pub(super) fn show_task_output(
        &mut self,
        tui: &mut tui::Tui,
        title: String,
        result: Result<Vec<String>, String>,
    ) {
        let lines = match result {
            Ok(lines) => lines,
            Err(error) => {
                self.chat_widget
                    .add_error_message(format!("Could not read the command's output: {error}"));
                return;
            }
        };
        let _ = tui.enter_alt_screen();
        let pager_lines = lines
            .iter()
            .map(|line| codex_ansi_escape::ansi_escape_line(line))
            .collect();
        self.overlay = Some(Overlay::new_static_with_lines(
            pager_lines,
            title,
            self.keymap.pager.clone(),
        ));
        tui.frame_requester().schedule_frame();
    }
}

/// The confirmation shown before a stop.
pub(super) fn stop_confirmation_params(
    target: TreeTarget,
    label: String,
    reopen_tasks: bool,
) -> SelectionViewParams {
    let (title, stop_label, stop_description) = match &target {
        TreeTarget::Thread(_) => (
            format!("Stop {label}?"),
            "Yes, stop the agent",
            "Interrupt its current turn; the agent that started it is told",
        ),
        TreeTarget::ExecSession { .. } => (
            format!("Stop `{label}`?"),
            "Yes, stop the command",
            "Terminate the process; the agent sees it was killed",
        ),
    };
    let back = move |tx: &crate::app_event_sender::AppEventSender| {
        if reopen_tasks {
            tx.send(AppEvent::OpenTasks);
        }
    };
    SelectionViewParams {
        title: Some(title),
        items: vec![
            SelectionItem {
                name: stop_label.to_string(),
                description: Some(stop_description.to_string()),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::StopTask {
                        target: target.clone(),
                        reopen_tasks,
                    });
                })],
                dismiss_on_select: true,
                ..Default::default()
            },
            SelectionItem {
                name: "No, keep it running".to_string(),
                actions: vec![Box::new(back)],
                dismiss_on_select: true,
                ..Default::default()
            },
        ],
        initial_selected_idx: Some(1),
        on_cancel: Some(Box::new(back)),
        ..SelectionViewParams::confirmation()
    }
}

#[cfg(test)]
#[path = "unieai_tasks_tests.rs"]
mod unieai_tasks_tests;
