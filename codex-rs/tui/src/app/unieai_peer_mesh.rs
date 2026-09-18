// Copyright (c) 2026 UnieAI. All rights reserved.
//! The app's side of the session mesh: the peer browser, `/peer`, the
//! passive poller that feeds transcript cards and the unread badge, the
//! approve/deny prompt for held messages, and uac-engine membership.
//!
//! Everything here follows the primary thread. `/new`, `/resume`, and
//! switching threads all go through [`App::sync_peer_mesh`], which re-points
//! the poller and moves uac membership to the new thread.

use super::*;
use std::collections::HashSet;
use std::sync::Arc;

use codex_app_server_protocol::DynamicToolCallParams;
use codex_app_server_protocol::UserInput;
use codex_state::SessionMeshMessageRecord;
use unieai_session_mesh::wire::Delivery;

use crate::unieai_mesh::UacMeshMember;

/// State for the mesh surfaces, kept together on the app.
#[derive(Default)]
pub(crate) struct PeerMeshState {
    /// Re-points the running poller at another thread.
    poller_thread: Option<tokio::sync::watch::Sender<ThreadId>>,
    /// The uac thread this TUI has joined to the mesh, if any.
    uac_member: Option<Arc<UacMeshMember>>,
    /// A join in flight, so a second sync does not start another.
    uac_joining: Option<ThreadId>,
    /// Peer messages for an idle uac thread that were not allowed to start a
    /// turn. They go in front of the user's next prompt.
    uac_pending_inputs: Vec<String>,
    /// Held messages already put in front of the user, so the poller does not
    /// reopen the prompt every tick.
    prompted_held: HashSet<String>,
}

impl App {
    /// Engine the primary thread runs on, as stamped on outgoing messages.
    fn mesh_engine(&self) -> &'static str {
        match crate::unieai_engine::target_engine(&self.config.codex_home, &self.app_server_target)
        {
            crate::unieai_engine::EngineKind::Uac => crate::unieai_mesh::ENGINE_UAC,
            crate::unieai_engine::EngineKind::Codex => crate::unieai_mesh::ENGINE_CODEX,
        }
    }

    fn mesh_available(&self) -> Result<(), crate::peers::PeerBusUnavailable> {
        crate::peers::peer_bus_available(
            self.config
                .features
                .enabled(codex_features::Feature::SessionMesh),
            self.state_db.is_some(),
            &self.app_server_target,
        )
    }

    /// Points every mesh surface at `thread_id`, the new primary thread.
    pub(super) fn sync_peer_mesh(&mut self, thread_id: ThreadId) {
        if self.mesh_available().is_err() {
            return;
        }
        self.spawn_peer_bus_poller(thread_id);
        self.sync_uac_membership(thread_id);
    }

    /// Joins a uac thread to the mesh, leaving whichever thread was joined
    /// before. Codex-engine threads join from core and are left alone.
    fn sync_uac_membership(&mut self, thread_id: ThreadId) {
        let is_uac = self.mesh_engine() == crate::unieai_mesh::ENGINE_UAC;
        if let Some(member) = self.peer_mesh.uac_member.as_ref()
            && (member.thread_id != thread_id || !is_uac)
        {
            let member = self.peer_mesh.uac_member.take();
            self.peer_mesh.uac_pending_inputs.clear();
            if let Some(member) = member {
                tokio::spawn(async move { member.node.leave().await });
            }
        }
        if !is_uac
            || self.peer_mesh.uac_member.is_some()
            || self.peer_mesh.uac_joining == Some(thread_id)
        {
            return;
        }
        let Some(state_db) = self.state_db.clone() else {
            return;
        };
        self.peer_mesh.uac_joining = Some(thread_id);
        let config = self.config.clone();
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result =
                UacMeshMember::join(&config, state_db, thread_id, app_event_tx.clone()).await;
            app_event_tx.send(AppEvent::UacMeshJoined {
                thread_id,
                result: result.map(|member| crate::unieai_mesh::JoinedMember(Arc::new(member))),
            });
        });
    }

    pub(super) fn handle_uac_mesh_joined(
        &mut self,
        thread_id: ThreadId,
        result: Result<crate::unieai_mesh::JoinedMember, unieai_session_mesh::MeshError>,
    ) {
        if self.peer_mesh.uac_joining == Some(thread_id) {
            self.peer_mesh.uac_joining = None;
        }
        match result {
            Ok(crate::unieai_mesh::JoinedMember(member)) => {
                if self.primary_thread_id == Some(thread_id) && self.peer_mesh.uac_member.is_none()
                {
                    self.peer_mesh.uac_member = Some(member);
                } else {
                    // The user moved on while the join was in flight.
                    tokio::spawn(async move { member.node.leave().await });
                }
            }
            Err(err) => tracing::warn!("uac thread could not join the session mesh: {err}"),
        }
    }

    /// The member for `thread_id`, with its permission mode refreshed from
    /// the current settings.
    fn uac_member_for(&self, thread_id: ThreadId) -> Option<Arc<UacMeshMember>> {
        let member = self
            .peer_mesh
            .uac_member
            .as_ref()
            .filter(|member| member.thread_id == thread_id)?;
        member.set_mode(crate::unieai_mesh::permission_mode_for_config(&self.config));
        Some(Arc::clone(member))
    }

    /// Delivers a peer's framed message into a uac thread: steers a running
    /// turn, starts one when idle and allowed, and otherwise keeps it for the
    /// user's next prompt. Returns what actually happened.
    pub(super) async fn deliver_uac_peer_message(
        &mut self,
        app_server: &mut AppServerSession,
        thread_id: ThreadId,
        text: String,
        trigger_turn: bool,
    ) -> Delivery {
        if self.uac_member_for(thread_id).is_none() {
            return Delivery::Rejected;
        }
        if let Some(turn_id) = self.active_turn_id_for_thread(thread_id).await {
            let steered = app_server
                .turn_steer(
                    thread_id,
                    turn_id,
                    crate::unieai_mesh::peer_delivery_client_id(),
                    vec![UserInput::Text {
                        text: text.clone(),
                        text_elements: Vec::new(),
                    }],
                )
                .await;
            if steered.is_err() {
                self.peer_mesh.uac_pending_inputs.push(text);
            }
            return Delivery::Queued;
        }
        if !trigger_turn {
            self.peer_mesh.uac_pending_inputs.push(text);
            return Delivery::Queued;
        }
        let op = self.chat_widget.peer_delivery_turn(text.clone());
        match self.submit_thread_op(app_server, thread_id, op).await {
            Ok(()) => Delivery::StartedTurn,
            Err(err) => {
                tracing::warn!("failed to start a turn for a peer message: {err}");
                self.peer_mesh.uac_pending_inputs.push(text);
                Delivery::Queued
            }
        }
    }

    pub(super) async fn answer_uac_peer_probe(&self, thread_id: ThreadId) -> bool {
        self.active_turn_id_for_thread(thread_id).await.is_some()
    }

    /// Called for every turn about to be sent to `thread_id`. User input
    /// resets the relay limits, and peer messages kept for the user's next
    /// prompt are put in front of it. Peer deliveries pass through as-is.
    pub(super) fn prepare_turn_items_for_mesh(
        &mut self,
        thread_id: ThreadId,
        client_user_message_id: &str,
        items: &[UserInput],
    ) -> Vec<UserInput> {
        if crate::unieai_mesh::is_peer_delivery_client_id(client_user_message_id) {
            return items.to_vec();
        }
        let Some(member) = self.uac_member_for(thread_id) else {
            return items.to_vec();
        };
        member.node.note_user_input();
        let mut prepared: Vec<UserInput> = self
            .peer_mesh
            .uac_pending_inputs
            .drain(..)
            .map(|text| UserInput::Text {
                text,
                text_elements: Vec::new(),
            })
            .collect();
        prepared.extend(items.iter().cloned());
        prepared
    }

    /// Answers a `codex_tui` `list_peers` / `send_peer_message` call from a
    /// uac thread. Returns `false` when the call is not a peer tool.
    pub(super) fn handle_peer_dynamic_tool_call(
        &mut self,
        request_id: &codex_app_server_protocol::RequestId,
        params: &DynamicToolCallParams,
    ) -> bool {
        if !crate::unieai_mesh::is_peer_tool(&params.tool) {
            return false;
        }
        let member = ThreadId::from_string(&params.thread_id)
            .ok()
            .and_then(|thread_id| self.uac_member_for(thread_id));
        let app_event_tx = self.app_event_tx.clone();
        let request_id = request_id.clone();
        let Some(member) = member else {
            app_event_tx.send(AppEvent::DynamicToolCallCompleted {
                request_id,
                response: crate::dynamic_tools::failure_response(
                    "the session mesh is not available in this session",
                ),
            });
            return true;
        };
        let tool = params.tool.clone();
        let arguments = params.arguments.clone();
        tokio::spawn(async move {
            let response = crate::unieai_mesh::execute_peer_tool(
                Arc::clone(&member.node),
                member.mode(),
                &tool,
                arguments,
            )
            .await;
            app_event_tx.send(AppEvent::DynamicToolCallCompleted {
                request_id,
                response,
            });
        });
        true
    }

    /// Opens the peer browser.
    ///
    /// Probes every peer so the list shows who is idle or busy right now, and
    /// never includes this session itself.
    pub(super) fn open_peers_picker(&mut self) {
        if let Err(unavailable) = self.mesh_available() {
            // Unavailable and empty must not look the same, so say which.
            self.chat_widget
                .add_error_message(unavailable.message().to_string());
            return;
        }
        let (Some(thread_id), Some(state_db)) = (self.primary_thread_id, self.state_db.clone())
        else {
            self.chat_widget
                .add_error_message("No active session to list peers for.".to_string());
            return;
        };
        // Offer any held message again, in case its prompt was dismissed.
        self.peer_mesh.prompted_held.clear();
        let sender =
            crate::unieai_mesh::sender_for(&self.config, state_db, thread_id, self.mesh_engine());
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = sender
                .list_peers()
                .await
                .map(|peers| crate::peers::peer_rows(&peers))
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::PeersListed { result });
        });
    }

    pub(super) fn show_peers_picker(&mut self, result: Result<Vec<crate::peers::PeerRow>, String>) {
        let rows = match result {
            Ok(rows) => rows,
            Err(err) => {
                self.chat_widget
                    .add_error_message(format!("Could not list peers: {err}"));
                return;
            }
        };
        let rows = crate::peers::exclude_thread(rows, self.primary_thread_id);
        self.peer_rows = rows.clone();
        if rows.is_empty() {
            self.chat_widget.add_info_message(
                "No other sessions are reachable on this machine yet.".to_string(),
                Some("start another `unieai` session to see it here".to_string()),
            );
            return;
        }

        let items: Vec<SelectionItem> = rows
            .iter()
            .map(|peer| {
                let handle = peer.handle.clone();
                let target = peer.handle.clone();
                SelectionItem {
                    name: handle.clone(),
                    description: Some(format!("{}  {}", peer.status, peer.cwd.display())),
                    search_value: Some(format!("{handle} {}", peer.cwd.display())),
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::PeerPickerSelected {
                            target: target.clone(),
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                }
            })
            .collect();

        self.chat_widget.show_selection_view(SelectionViewParams {
            title: Some("Sessions on this machine".to_string()),
            subtitle: Some("select one to message it with /peer".to_string()),
            footer_hint: Some(standard_popup_hint_line()),
            items,
            ..Default::default()
        });
    }

    /// Sends a message to a peer on behalf of this session's user.
    ///
    /// Uses a sender rather than a second mesh membership: this session already
    /// has a listener (in core, or the uac membership above), and publishing
    /// another registry row for it would show the user a duplicate of
    /// themselves.
    pub(super) fn send_peer_message(&mut self, target: String, message: String) {
        let Some(thread_id) = self.primary_thread_id else {
            self.chat_widget
                .add_error_message("No active session to send from.".to_string());
            return;
        };
        let Some(state_db) = self.state_db.clone() else {
            self.chat_widget.add_error_message(
                crate::peers::PeerBusUnavailable::NoStateDatabase
                    .message()
                    .to_string(),
            );
            return;
        };
        // The user typed this, so a human is in the conversation again.
        if let Some(member) = self.uac_member_for(thread_id) {
            member.node.note_user_input();
        }
        let permissions = crate::unieai_mesh::permission_mode_for_config(&self.config);
        let sender =
            crate::unieai_mesh::sender_for(&self.config, state_db, thread_id, self.mesh_engine());
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let selector = unieai_session_mesh::PeerSelector::new(target);
            let result = match sender.resolve(&selector).await {
                Ok(peer) => sender
                    .send_message(
                        &peer,
                        &message,
                        /*trigger_turn*/ true,
                        /*hop*/ 0,
                        Some(permissions),
                    )
                    .await
                    .map(|ack| {
                        format!(
                            "delivered to {}: {}{}",
                            peer.display_handle(unieai_session_mesh::SHORT_REF_MIN_LEN),
                            ack.delivery.as_str(),
                            ack.reject_reason
                                .map(|reason| format!(" ({reason})"))
                                .unwrap_or_default()
                        )
                    }),
                Err(err) => Err(err),
            };
            app_event_tx.send(AppEvent::PeerMessageSent {
                result: result.map_err(|err| err.to_string()),
            });
        });
    }

    /// Renders one peer-bus refresh.
    ///
    /// Every settled message becomes a transcript card. A message that can
    /// start a turn must never be invisible, or the user cannot account for
    /// work their session did while they were looking elsewhere. Held messages
    /// are put in front of the user to approve or deny.
    pub(super) fn handle_peer_bus_update(
        &mut self,
        thread_id: ThreadId,
        peers: Vec<crate::peers::PeerRow>,
        new_messages: Vec<SessionMeshMessageRecord>,
        held: Vec<SessionMeshMessageRecord>,
    ) {
        if self.primary_thread_id != Some(thread_id) {
            // A refresh for a thread the user has since left.
            return;
        }
        let peers = crate::peers::exclude_thread(peers, Some(thread_id));
        for message in &new_messages {
            let from = crate::peers::sender_handle(message, &peers);
            self.chat_widget
                .add_to_history(crate::peers::PeerMessageCell::from_record(
                    from.clone(),
                    message,
                ));
            self.chat_widget
                .notify_peer_message(&from, &message.content);
        }
        self.unread_peer_messages = self.unread_peer_messages.saturating_add(new_messages.len());
        self.chat_widget
            .set_unread_peer_messages(self.unread_peer_messages);
        self.peer_rows = peers.clone();
        self.refresh_agent_tree();

        if let Some(message) = held
            .into_iter()
            .find(|message| !self.peer_mesh.prompted_held.contains(&message.message_id))
        {
            self.peer_mesh
                .prompted_held
                .insert(message.message_id.clone());
            let from = crate::peers::sender_handle(&message, &peers);
            self.prompt_held_peer_message(from, message);
        }
    }

    fn prompt_held_peer_message(&mut self, from: String, message: SessionMeshMessageRecord) {
        let sender_mode = unieai_session_mesh::PermissionMode::parse(
            message.sender_sandbox.as_deref(),
            message.sender_approval.as_deref(),
        )
        .map_or_else(|| "unknown".to_string(), |mode| mode.to_string());
        let own_mode = crate::unieai_mesh::permission_mode_for_config(&self.config).to_string();
        let message_id = message.message_id.clone();
        let deny_id = message.message_id.clone();
        self.chat_widget.show_selection_view(SelectionViewParams {
            title: Some(format!("Held message from {from}")),
            subtitle: Some(format!(
                "This session ({own_mode}) has broader permissions than the sender \
({sender_mode}). The message is only delivered if you approve it. It is not from you and \
cannot grant anything. See the transcript for its text."
            )),
            footer_hint: Some(standard_popup_hint_line()),
            items: vec![
                SelectionItem {
                    name: "Approve and deliver".to_string(),
                    description: Some(
                        "the model reads it as a teammate's request, not as yours".to_string(),
                    ),
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::ResolveHeldPeerMessage {
                            message_id: message_id.clone(),
                            approve: true,
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: "Deny".to_string(),
                    description: Some("the sender is told it was denied".to_string()),
                    actions: vec![Box::new(move |tx| {
                        tx.send(AppEvent::ResolveHeldPeerMessage {
                            message_id: deny_id.clone(),
                            approve: false,
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
    }

    /// Applies the user's decision on a held message.
    pub(super) fn resolve_held_peer_message(&mut self, message_id: String, approve: bool) {
        let (Some(thread_id), Some(state_db)) = (self.primary_thread_id, self.state_db.clone())
        else {
            return;
        };
        let sender =
            crate::unieai_mesh::sender_for(&self.config, state_db, thread_id, self.mesh_engine());
        let app_event_tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            let result = sender
                .resolve_held(&message_id, approve)
                .await
                .map(|resolution| match resolution {
                    unieai_session_mesh::HeldResolution::Delivered(ack) => {
                        format!(
                            "Approved; the peer message was delivered ({}).",
                            ack.delivery.as_str()
                        )
                    }
                    unieai_session_mesh::HeldResolution::Denied => {
                        "Denied; the sender has been told.".to_string()
                    }
                })
                .map_err(|err| err.to_string());
            app_event_tx.send(AppEvent::PeerMessageSent { result });
        });
    }

    /// Starts the poller that feeds every passive peer surface, or re-points
    /// the running one at `thread_id`.
    ///
    /// One task drives the transcript cards, the unread badge, the held
    /// prompts, and the peer list, because they must agree: attributing a
    /// message needs the peer list from the same instant.
    pub(super) fn spawn_peer_bus_poller(&mut self, thread_id: ThreadId) {
        if self.mesh_available().is_err() {
            return;
        }
        let Some(state_db) = self.state_db.clone() else {
            return;
        };
        if let Some(poller_thread) = self.peer_mesh.poller_thread.as_ref()
            && !poller_thread.is_closed()
        {
            poller_thread.send_replace(thread_id);
            return;
        }

        let (poller_thread, mut followed) = tokio::sync::watch::channel(thread_id);
        self.peer_mesh.poller_thread = Some(poller_thread);
        let retention_ms =
            unieai_session_mesh::MeshConfig::new(self.config.codex_home.to_path_buf())
                .message_retention
                .as_millis() as i64;
        let app_event_tx = self.app_event_tx.clone();
        self.peer_bus_poller = Some(tokio::spawn(async move {
            let mut thread_id = *followed.borrow_and_update();
            let mut feed = crate::peers::PeerFeed::new(crate::peers::now_ms());
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(crate::peers::PEER_BUS_POLL_INTERVAL) => {}
                    changed = followed.changed() => {
                        if changed.is_err() {
                            break;
                        }
                    }
                }
                let current = *followed.borrow_and_update();
                if current != thread_id {
                    thread_id = current;
                    feed = crate::peers::PeerFeed::new(crate::peers::now_ms());
                }

                let peers = match state_db.list_session_mesh_peers().await {
                    Ok(peers) => crate::peers::live_rows_from_records(&peers).await,
                    Err(_) => continue,
                };
                let recent = match state_db
                    .list_session_mesh_messages_for(
                        thread_id,
                        crate::peers::now_ms().saturating_sub(retention_ms),
                    )
                    .await
                {
                    Ok(messages) => messages,
                    Err(_) => continue,
                };
                let held = state_db
                    .list_held_session_mesh_messages(thread_id)
                    .await
                    .unwrap_or_default();
                let new_messages = feed.take_new(recent);
                if peers.is_empty() && new_messages.is_empty() && held.is_empty() {
                    continue;
                }
                app_event_tx.send(AppEvent::PeerBusUpdated {
                    thread_id,
                    peers,
                    new_messages,
                    held,
                });
            }
        }));
    }
}
