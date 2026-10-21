// Copyright (c) 2026 UnieAI. All rights reserved.
//! Onboarding's "Use a self-hosted model server" flow: the server URL, an
//! optional API key, then a probe of `GET /models` that either saves the
//! server (`codex_login::unieai_self_hosted`) or says why it could not.

use codex_login::unieai_self_hosted::SelfHostedError;
use codex_login::unieai_self_hosted::SelfHostedRequest;

use super::*;

/// How many discovered model ids the success screen names before "+N more".
const MODELS_SHOWN: usize = 5;

#[derive(Clone)]
pub(crate) enum SelfHostedState {
    UrlEntry {
        value: String,
    },
    KeyEntry {
        base_url: String,
        value: String,
    },
    Probing {
        base_url: String,
    },
    Connected {
        id: String,
        base_url: String,
        models: Vec<String>,
    },
}

impl SelfHostedState {
    pub(super) fn is_text_entry(&self) -> bool {
        matches!(self, Self::UrlEntry { .. } | Self::KeyEntry { .. })
    }

    pub(super) fn has_text(&self) -> bool {
        match self {
            Self::UrlEntry { value } | Self::KeyEntry { value, .. } => !value.is_empty(),
            _ => false,
        }
    }

    pub(super) fn step_state(&self) -> StepState {
        match self {
            Self::Connected { .. } => StepState::Complete,
            _ => StepState::InProgress,
        }
    }
}

fn is_text_char(key_event: &KeyEvent) -> Option<char> {
    match key_event.code {
        KeyCode::Char(c)
            if key_event.kind == KeyEventKind::Press
                && !key_event.modifiers.contains(KeyModifiers::SUPER)
                && !key_event.modifiers.contains(KeyModifiers::CONTROL)
                && !key_event.modifiers.contains(KeyModifiers::ALT) =>
        {
            Some(c)
        }
        _ => None,
    }
}

impl AuthModeWidget {
    pub(super) fn start_self_hosted_entry(&mut self) {
        self.set_error(/*message*/ None);
        *self.sign_in_state.write().unwrap() = SignInState::SelfHosted(SelfHostedState::UrlEntry {
            value: String::new(),
        });
        self.request_frame.schedule_frame();
    }

    /// Keys while the self-hosted flow is on screen; false when it is not.
    pub(super) fn handle_self_hosted_key_event(&mut self, key_event: &KeyEvent) -> bool {
        let mut probe: Option<(String, Option<String>)> = None;
        {
            let mut guard = self.sign_in_state.write().unwrap();
            let SignInState::SelfHosted(state) = &mut *guard else {
                return false;
            };
            let cancel = keys::CANCEL.is_pressed(*key_event);
            let confirm = keys::CONFIRM.is_pressed(*key_event);
            match state {
                SelfHostedState::UrlEntry { value } => {
                    if cancel {
                        *guard = SignInState::PickMode;
                        self.set_error(/*message*/ None);
                    } else if confirm {
                        match codex_login::unieai_self_hosted::normalize_base_url(value) {
                            Ok(base_url) => {
                                *state = SelfHostedState::KeyEntry {
                                    base_url,
                                    value: String::new(),
                                };
                                self.set_error(/*message*/ None);
                            }
                            Err(_) if value.trim().is_empty() => {
                                self.set_error(Some("Server URL cannot be empty".to_string()));
                            }
                            Err(err) => self.set_error(Some(err.to_string())),
                        }
                    } else if key_event.code == KeyCode::Backspace {
                        value.pop();
                        self.set_error(/*message*/ None);
                    } else if let Some(c) = is_text_char(key_event) {
                        value.push(c);
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::KeyEntry { base_url, value } => {
                    if cancel {
                        *state = SelfHostedState::UrlEntry {
                            value: base_url.clone(),
                        };
                        self.set_error(/*message*/ None);
                    } else if confirm {
                        let key = value.trim().to_string();
                        probe = Some((base_url.clone(), (!key.is_empty()).then_some(key)));
                    } else if key_event.code == KeyCode::Backspace {
                        value.pop();
                        self.set_error(/*message*/ None);
                    } else if let Some(c) = is_text_char(key_event) {
                        value.push(c);
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::Probing { base_url } => {
                    if cancel {
                        if let Some(abort) = self.unieai_login_abort.write().unwrap().take() {
                            abort.abort();
                        }
                        *state = SelfHostedState::UrlEntry {
                            value: base_url.clone(),
                        };
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::Connected { .. } => return false,
            }
        }
        match probe {
            Some((base_url, api_key)) => self.start_self_hosted_probe(base_url, api_key),
            None => self.request_frame.schedule_frame(),
        }
        true
    }

    pub(super) fn handle_self_hosted_paste(&mut self, pasted: &str) -> bool {
        let trimmed = pasted.trim();
        if trimmed.is_empty() {
            return false;
        }
        let mut guard = self.sign_in_state.write().unwrap();
        match &mut *guard {
            SignInState::SelfHosted(
                SelfHostedState::UrlEntry { value } | SelfHostedState::KeyEntry { value, .. },
            ) => value.push_str(trimmed),
            _ => return false,
        }
        drop(guard);
        self.set_error(/*message*/ None);
        self.request_frame.schedule_frame();
        true
    }

    /// Probes and saves the server on a background task: Connected on
    /// success; back to the key step for a refused key, else the URL step.
    fn start_self_hosted_probe(&mut self, base_url: String, api_key: Option<String>) {
        self.set_error(/*message*/ None);
        *self.sign_in_state.write().unwrap() = SignInState::SelfHosted(SelfHostedState::Probing {
            base_url: base_url.clone(),
        });
        let codex_home = self.codex_home.clone();
        let sign_in_state = self.sign_in_state.clone();
        let error = self.error.clone();
        let request_frame = self.request_frame.clone();
        let join_handle = tokio::spawn(async move {
            let request = SelfHostedRequest {
                base_url: base_url.clone(),
                api_key,
                ..Default::default()
            };
            let next = match codex_login::unieai_self_hosted::add_self_hosted_provider(
                &codex_home,
                request,
            )
            .await
            {
                Ok(server) => {
                    *error.write().unwrap() = None;
                    SelfHostedState::Connected {
                        id: server.id.clone(),
                        base_url: server.base_url.clone(),
                        models: server.models.iter().map(|m| m.id.clone()).collect(),
                    }
                }
                Err(err @ SelfHostedError::Unauthorized { .. }) => {
                    *error.write().unwrap() = Some(err.to_string());
                    SelfHostedState::KeyEntry {
                        base_url,
                        value: String::new(),
                    }
                }
                Err(err) => {
                    *error.write().unwrap() = Some(err.to_string());
                    SelfHostedState::UrlEntry { value: base_url }
                }
            };
            *sign_in_state.write().unwrap() = SignInState::SelfHosted(next);
            request_frame.schedule_frame();
        });
        *self.unieai_login_abort.write().unwrap() = Some(join_handle.abort_handle());
        self.request_frame.schedule_frame();
    }

    pub(super) fn render_self_hosted(&self, area: Rect, buf: &mut Buffer, state: &SelfHostedState) {
        match state {
            SelfHostedState::UrlEntry { value } => self.render_self_hosted_input(
                area,
                buf,
                vec![
                    "  Connect an OpenAI-compatible server you run yourself: vLLM, SGLang, TGI,"
                        .into(),
                    "  llama.cpp, Ollama, LM Studio, … No UnieAI account is needed.".into(),
                    "".into(),
                    "  Enter its URL (e.g. localhost:11434 or http://gpu-box:8000/v1).".into(),
                ],
                "Server URL",
                (!value.is_empty()).then(|| value.clone()),
                "Paste or type the server URL",
                " to continue",
            ),
            SelfHostedState::KeyEntry { base_url, value } => self.render_self_hosted_input(
                area,
                buf,
                vec![
                    Line::from(format!("  Server: {base_url}")),
                    "".into(),
                    "  Enter the server's API key, or leave it empty if it needs none.".into(),
                    "  The key is stored owner-only in your UnieAI home.".into(),
                ],
                "API key (optional)",
                // Never echo the key itself.
                (!value.is_empty()).then(|| "•".repeat(value.chars().count().min(48))),
                "Press Enter without a key if the server has none",
                " to connect",
            ),
            SelfHostedState::Probing { base_url } => {
                let lines: Vec<Line> = vec![
                    Line::from(vec!["> ".into(), "Use a self-hosted model server".bold()]),
                    "".into(),
                    Line::from(format!("  Asking {base_url}/models for its models…")).dim(),
                    "".into(),
                    Line::from(vec![
                        "  Press ".dim(),
                        self.cancel_binding().into(),
                        " to cancel".dim(),
                    ]),
                ];
                Paragraph::new(lines)
                    .wrap(Wrap { trim: false })
                    .render(area, buf);
            }
            SelfHostedState::Connected {
                id,
                base_url,
                models,
            } => {
                let mut shown = models
                    .iter()
                    .take(MODELS_SHOWN)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                if models.len() > MODELS_SHOWN {
                    shown.push_str(&format!(" (+{} more)", models.len() - MODELS_SHOWN));
                }
                let lines: Vec<Line> =
                    vec![
                    "✓ Connected to your self-hosted model server".fg(Color::Green).into(),
                    "".into(),
                    Line::from(format!("  Server:  {id} · {base_url}")).dim(),
                    Line::from(format!("  Models:  {shown}")).dim(),
                    "".into(),
                    Line::from(format!(
                        "  Pick one with /model (listed as {id}/<model>). Self-hosted models run on"
                    ))
                    .dim(),
                    "  the uac engine (unieai-agent-core).".dim().into(),
                ];
                Paragraph::new(lines)
                    .wrap(Wrap { trim: false })
                    .render(area, buf);
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn render_self_hosted_input(
        &self,
        area: Rect,
        buf: &mut Buffer,
        intro: Vec<Line<'static>>,
        title: &str,
        value: Option<String>,
        placeholder: &str,
        confirm_label: &str,
    ) {
        let [intro_area, input_area, footer_area] = Layout::vertical([
            Constraint::Min(6),
            Constraint::Length(3),
            Constraint::Min(2),
        ])
        .areas(area);

        let mut intro_lines: Vec<Line> = vec![
            Line::from(vec!["> ".into(), "Use a self-hosted model server".bold()]),
            "".into(),
        ];
        intro_lines.extend(intro);
        intro_lines.push("".into());
        Paragraph::new(intro_lines)
            .wrap(Wrap { trim: false })
            .render(intro_area, buf);

        let content_line: Line = match value {
            Some(value) => Line::from(value),
            None => vec![placeholder.to_string().dim()].into(),
        };
        Paragraph::new(content_line)
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(title.to_string())
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(Color::Cyan)),
            )
            .render(input_area, buf);

        let mut footer_lines: Vec<Line> = vec![
            Line::from(vec![
                "  Press ".dim(),
                self.confirm_binding().into(),
                confirm_label.to_string().dim(),
            ]),
            Line::from(vec![
                "  Press ".dim(),
                self.cancel_binding().into(),
                " to go back".dim(),
            ]),
        ];
        if let Some(error) = self.error_message() {
            footer_lines.push("".into());
            footer_lines.push(error.red().into());
        }
        Paragraph::new(footer_lines)
            .wrap(Wrap { trim: false })
            .render(footer_area, buf);
    }
}
