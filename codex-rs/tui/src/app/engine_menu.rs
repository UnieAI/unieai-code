//! `/engine`: pick the agent engine for new sessions.
//!
//! The choice is persisted and the CLI relaunches onto it; the current
//! conversation stays with the engine that started it.

use super::*;
use crate::RemoteAppServerEndpoint;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::engine_selection;
use crate::engine_selection::EngineKind;
use crate::wrapping::word_wrap_lines;
use ratatui::buffer::Buffer;
use ratatui::widgets::Paragraph;

struct EngineMenuHeader(Vec<Line<'static>>);

impl Renderable for EngineMenuHeader {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        Renderable::render(
            &Paragraph::new(word_wrap_lines(&self.0, usize::from(area.width))),
            area,
            buf,
        );
    }

    fn desired_height(&self, width: u16) -> u16 {
        word_wrap_lines(&self.0, usize::from(width)).len() as u16
    }
}

impl App {
    /// The engine this session is actually running on, which can differ from
    /// the configured one when the uac server failed to start.
    pub(super) fn running_engine(&self) -> EngineKind {
        match &self.app_server_target {
            AppServerTarget::LocalDaemon {
                endpoint: RemoteAppServerEndpoint::UnixSocket { socket_path },
                ..
            } if engine_selection::is_uac_socket(
                &self.config.codex_home,
                socket_path.as_path(),
            ) =>
            {
                EngineKind::Uac
            }
            _ => EngineKind::Codex,
        }
    }

    pub(super) fn open_engine_menu(&mut self) {
        let codex_home = self.config.codex_home.to_path_buf();
        let running = self.running_engine();
        let configured = engine_selection::resolve_engine(&codex_home);
        let mut header = vec![
            Line::from("Engine".bold()),
            Line::from(format!("This session: {}", running.display_name()).dim()),
        ];
        if configured != running {
            header.push(Line::from(
                format!(
                    "Configured {} is not running; see {}",
                    configured.display_name(),
                    engine_selection::uac_log_path(&codex_home).display()
                )
                .dim(),
            ));
        }
        header.push(Line::from(
            "Switching restarts UnieAI Code in a new session.".dim(),
        ));
        let items = EngineKind::ALL
            .into_iter()
            .map(|engine| SelectionItem {
                name: engine.display_name().to_string(),
                description: Some(engine.description().to_string()),
                is_current: engine == running,
                actions: vec![Box::new(move |tx| tx.send(AppEvent::SwitchEngine(engine)))],
                dismiss_on_select: true,
                ..Default::default()
            })
            .collect();
        self.chat_widget.show_selection_view(SelectionViewParams {
            header: Box::new(EngineMenuHeader(header)),
            items,
            ..Default::default()
        });
    }

    /// Persist `engine` and report whether the CLI should relaunch onto it.
    pub(super) fn switch_engine(&mut self, engine: EngineKind) -> bool {
        let codex_home = self.config.codex_home.to_path_buf();
        if std::env::var_os(engine_selection::ENGINE_ENV_VAR).is_some() {
            self.chat_widget.add_error_message(format!(
                "{} is set for this launch and overrides /engine; unset it to switch.",
                engine_selection::ENGINE_ENV_VAR
            ));
            return false;
        }
        if let Err(err) = engine_selection::write_engine(&codex_home, engine) {
            self.chat_widget
                .add_error_message(format!("Failed to save engine choice: {err}"));
            return false;
        }
        if engine == self.running_engine() {
            self.chat_widget.add_info_message(
                format!("Already running on {}.", engine.display_name()),
                /*hint*/ None,
            );
            return false;
        }
        true
    }
}
