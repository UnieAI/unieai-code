// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/engine`: pick the agent engine for new sessions.
//!
//! The choice is persisted and the CLI relaunches onto it; the current
//! conversation stays with the engine that started it. uac is listed once per
//! dsh mode.

use super::*;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::unieai_engine;
use crate::unieai_engine::EngineKind;
use crate::unieai_engine::UacMode;
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
        unieai_engine::target_engine(&self.config.codex_home, &self.app_server_target)
    }

    pub(super) fn open_engine_menu(&mut self) {
        let codex_home = self.config.codex_home.to_path_buf();
        let running = self.running_engine();
        let configured = unieai_engine::resolve_engine(&codex_home);
        let mut header = vec![
            Line::from("Engine".bold()),
            Line::from(format!("This session: {}", running.display_name()).dim()),
        ];
        if configured != running {
            header.push(Line::from(
                format!(
                    "Configured {} is not running; see {}",
                    configured.display_name(),
                    unieai_engine::uac_log_path(&codex_home).display()
                )
                .dim(),
            ));
        }
        header.push(Line::from(
            "Switching restarts UnieAI Code in a new session.".dim(),
        ));
        let codex_unavailable =
            unieai_engine::engine_unavailable_reason(&codex_home, EngineKind::Codex);
        let mut items = vec![SelectionItem {
            name: EngineKind::Codex.display_name().to_string(),
            description: Some(EngineKind::Codex.description().to_string()),
            is_current: running == EngineKind::Codex,
            is_disabled: codex_unavailable.is_some(),
            disabled_reason: codex_unavailable,
            actions: vec![Box::new(|tx| tx.send(AppEvent::SwitchEngine(EngineKind::Codex)))],
            dismiss_on_select: true,
            ..Default::default()
        }];
        let mode = unieai_engine::configured_uac_mode(&codex_home);
        items.extend(UacMode::ALL.into_iter().map(|candidate| SelectionItem {
            name: format!(
                "{} · {}",
                EngineKind::Uac.display_name(),
                candidate.display_name()
            ),
            description: Some(candidate.description().to_string()),
            is_current: running == EngineKind::Uac && candidate == mode,
            actions: vec![Box::new(move |tx| {
                tx.send(AppEvent::SwitchUacMode(candidate))
            })],
            dismiss_on_select: true,
            ..Default::default()
        }));
        self.chat_widget.show_selection_view(SelectionViewParams {
            header: Box::new(EngineMenuHeader(header)),
            items,
            ..Default::default()
        });
    }

    /// Persist uac in `mode` and report whether the CLI should relaunch: a
    /// new session is where a mode starts, even when uac is already running.
    pub(super) fn switch_uac_mode(&mut self, mode: UacMode) -> bool {
        let codex_home = self.config.codex_home.to_path_buf();
        let current = unieai_engine::configured_uac_mode(&codex_home);
        if let Err(err) = unieai_engine::write_uac_mode(&codex_home, mode) {
            self.chat_widget
                .add_error_message(format!("Failed to save the uac mode: {err}"));
            return false;
        }
        if self.running_engine() == EngineKind::Uac && mode == current {
            self.chat_widget.add_info_message(
                format!(
                    "Already running on {} in {} mode.",
                    EngineKind::Uac.display_name(),
                    mode.display_name()
                ),
                /*hint*/ None,
            );
            return false;
        }
        if self.running_engine() == EngineKind::Uac {
            return true;
        }
        self.switch_engine(EngineKind::Uac)
    }

    /// Persist `engine` and report whether the CLI should relaunch onto it.
    pub(super) fn switch_engine(&mut self, engine: EngineKind) -> bool {
        let codex_home = self.config.codex_home.to_path_buf();
        if std::env::var_os(unieai_engine::ENGINE_ENV_VAR).is_some() {
            self.chat_widget.add_error_message(format!(
                "{} is set for this launch and overrides /engine; unset it to switch.",
                unieai_engine::ENGINE_ENV_VAR
            ));
            return false;
        }
        if let Some(reason) = unieai_engine::engine_unavailable_reason(&codex_home, engine) {
            self.chat_widget
                .add_error_message(format!("{}: {reason}", engine.display_name()));
            return false;
        }
        if let Err(err) = unieai_engine::write_engine(&codex_home, engine) {
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
