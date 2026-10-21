// Copyright (c) 2026 UnieAI. All rights reserved.
//! Keeps the status line's "Remote: N viewers" current on the uac engine.

use super::App;
use crate::app_event::AppEvent;
use crate::app_server_session::AppServerSession;

impl App {
    /// Poll the uac server's Remote Control status in the background; a change
    /// redraws the status line. Remote Control may be started by another TUI
    /// or `unieai remote-control`, so a uac session watches from the start.
    pub(super) fn watch_remote_viewers(&self, app_server: &AppServerSession) {
        let app_event_tx = self.app_event_tx.clone();
        crate::unieai_remote::watch_viewers(app_server.request_handle(), move || {
            app_event_tx.send(AppEvent::RemoteViewersChanged);
        });
    }
}
