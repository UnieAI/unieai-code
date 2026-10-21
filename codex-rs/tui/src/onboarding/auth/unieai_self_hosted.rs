// Copyright (c) 2026 UnieAI. All rights reserved.
//! Onboarding's "Connect a model API" flow: pick a provider (OpenAI,
//! OpenRouter, …, a local Ollama or LM Studio, or a custom URL for a
//! self-hosted server), enter its API key, then see the models `GET /models`
//! lists, narrow them with a filter if there are many, and save the API
//! (`codex_login::unieai_self_hosted`).

use codex_login::unieai_self_hosted::API_PRESETS;
use codex_login::unieai_self_hosted::ApiPreset;
use codex_login::unieai_self_hosted::DiscoveredModel;
use codex_login::unieai_self_hosted::MAX_STORED_MODELS;
use codex_login::unieai_self_hosted::ProbedApi;
use codex_login::unieai_self_hosted::SelfHostedError;
use codex_login::unieai_self_hosted::SelfHostedRequest;

use super::*;

/// How many saved model ids the success screen names before "+N more".
const MODELS_SHOWN: usize = 3;
/// How many matching models the models step lists.
const MATCHES_SHOWN: usize = 6;
const TITLE: &str = "Connect a model API";
const CUSTOM_LABEL: &str = "Custom URL (vLLM, SGLang, llama.cpp, your own server…)";

/// The provider picked in the first step: a preset, or a custom URL.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ApiChoice {
    /// The preset; none for a custom URL.
    preset: Option<&'static ApiPreset>,
    base_url: String,
}

impl ApiChoice {
    fn label(&self) -> &str {
        self.preset
            .map_or("Self-hosted server", |preset| preset.label)
    }

    fn key_required(&self) -> bool {
        self.preset.is_some_and(|preset| preset.key_required)
    }

    /// Where this choice sits in the provider list.
    fn index(&self) -> usize {
        self.preset
            .and_then(|preset| API_PRESETS.iter().position(|p| p == preset))
            .unwrap_or(API_PRESETS.len())
    }

    fn request(&self, api_key: Option<String>) -> SelfHostedRequest {
        SelfHostedRequest {
            base_url: self.base_url.clone(),
            kind: Some(
                self.preset
                    .map_or(codex_login::unieai_self_hosted::CUSTOM_KIND, |preset| {
                        preset.kind
                    })
                    .to_string(),
            ),
            api_key,
            ..Default::default()
        }
    }
}

#[derive(Clone)]
pub(crate) enum SelfHostedState {
    /// The provider list; `highlighted` indexes the presets, then "Custom URL".
    ProviderPick {
        highlighted: usize,
    },
    UrlEntry {
        value: String,
    },
    KeyEntry {
        choice: ApiChoice,
        value: String,
    },
    Probing {
        choice: ApiChoice,
    },
    /// What `/models` listed; `filter` narrows what is saved.
    ModelsFound {
        choice: ApiChoice,
        api_key: Option<String>,
        models: Vec<DiscoveredModel>,
        filter: String,
    },
    Connected {
        id: String,
        label: String,
        base_url: String,
        models: Vec<String>,
        found: usize,
        codex_engine: bool,
    },
}

impl SelfHostedState {
    pub(super) fn is_text_entry(&self) -> bool {
        matches!(
            self,
            Self::UrlEntry { .. } | Self::KeyEntry { .. } | Self::ModelsFound { .. }
        )
    }

    pub(super) fn step_state(&self) -> StepState {
        match self {
            Self::Connected { .. } => StepState::Complete,
            _ => StepState::InProgress,
        }
    }
}

/// The models `filter` keeps, in the server's order.
fn matching<'a>(models: &'a [DiscoveredModel], filter: &str) -> Vec<&'a DiscoveredModel> {
    models
        .iter()
        .filter(|model| codex_login::unieai_self_hosted::model_matches_filter(&model.id, filter))
        .collect()
}

/// A provider as the picker lists it.
fn picker_label(preset: &ApiPreset) -> String {
    match preset.kind {
        "gemini" => format!("{} (OpenAI-compatible)", preset.label),
        _ if !preset.key_required => format!("{} (local)", preset.label),
        _ => preset.label.to_string(),
    }
}

fn host_of(base_url: &str) -> String {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| base_url.to_string())
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

/// What a key does to a text field: true when it edited the text.
fn edit_text(value: &mut String, key_event: &KeyEvent) -> bool {
    if key_event.code == KeyCode::Backspace {
        value.pop();
        true
    } else if let Some(c) = is_text_char(key_event) {
        value.push(c);
        true
    } else {
        false
    }
}

/// What the key handler leaves to do once the state lock is released.
enum Next {
    Nothing,
    Probe(ApiChoice, Option<String>),
    Save {
        choice: ApiChoice,
        api_key: Option<String>,
        models: Vec<DiscoveredModel>,
        filter: String,
    },
}

impl AuthModeWidget {
    pub(super) fn start_self_hosted_entry(&mut self) {
        self.set_error(/*message*/ None);
        *self.sign_in_state.write().unwrap() =
            SignInState::SelfHosted(SelfHostedState::ProviderPick { highlighted: 0 });
        self.request_frame.schedule_frame();
    }

    /// Keys while the API flow is on screen; false when it is not.
    pub(super) fn handle_self_hosted_key_event(&mut self, key_event: &KeyEvent) -> bool {
        let mut next = Next::Nothing;
        {
            let mut guard = self.sign_in_state.write().unwrap();
            let SignInState::SelfHosted(state) = &mut *guard else {
                return false;
            };
            let cancel = keys::CANCEL.is_pressed(*key_event);
            let confirm = keys::CONFIRM.is_pressed(*key_event);
            match state {
                SelfHostedState::ProviderPick { highlighted } => {
                    let count = API_PRESETS.len() + 1;
                    let digit = match key_event.code {
                        KeyCode::Char(c) if key_event.kind == KeyEventKind::Press => {
                            c.to_digit(10).map(|d| d as usize)
                        }
                        _ => None,
                    };
                    if cancel {
                        *guard = SignInState::PickMode;
                        self.set_error(/*message*/ None);
                        drop(guard);
                        self.request_frame.schedule_frame();
                        return true;
                    }
                    let pick = if confirm {
                        Some(*highlighted)
                    } else if let Some(d) = digit.filter(|d| (1..=count.min(9)).contains(d)) {
                        Some(d - 1)
                    } else if keys::MOVE_UP.is_pressed(*key_event) {
                        *highlighted = (*highlighted + count - 1) % count;
                        None
                    } else if keys::MOVE_DOWN.is_pressed(*key_event) {
                        *highlighted = (*highlighted + 1) % count;
                        None
                    } else {
                        return true;
                    };
                    if let Some(index) = pick {
                        self.set_error(/*message*/ None);
                        *state = match API_PRESETS.get(index) {
                            Some(preset) => SelfHostedState::KeyEntry {
                                choice: ApiChoice {
                                    preset: Some(preset),
                                    base_url: preset.base_url.to_string(),
                                },
                                value: String::new(),
                            },
                            None => SelfHostedState::UrlEntry {
                                value: String::new(),
                            },
                        };
                    }
                }
                SelfHostedState::UrlEntry { value } => {
                    if cancel {
                        *state = SelfHostedState::ProviderPick {
                            highlighted: API_PRESETS.len(),
                        };
                        self.set_error(/*message*/ None);
                    } else if confirm {
                        match codex_login::unieai_self_hosted::normalize_base_url(value) {
                            Ok(base_url) => {
                                *state = SelfHostedState::KeyEntry {
                                    choice: ApiChoice {
                                        preset: None,
                                        base_url,
                                    },
                                    value: String::new(),
                                };
                                self.set_error(/*message*/ None);
                            }
                            Err(_) if value.trim().is_empty() => {
                                self.set_error(Some("Server URL cannot be empty".to_string()));
                            }
                            Err(err) => self.set_error(Some(err.to_string())),
                        }
                    } else if edit_text(value, key_event) {
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::KeyEntry { choice, value } => {
                    if cancel {
                        *state = match choice.preset {
                            Some(_) => SelfHostedState::ProviderPick {
                                highlighted: choice.index(),
                            },
                            None => SelfHostedState::UrlEntry {
                                value: choice.base_url.clone(),
                            },
                        };
                        self.set_error(/*message*/ None);
                    } else if confirm {
                        let key = value.trim().to_string();
                        if key.is_empty() && choice.key_required() {
                            self.set_error(Some(format!(
                                "{} needs an API key; paste it to continue",
                                choice.label()
                            )));
                        } else {
                            next = Next::Probe(choice.clone(), (!key.is_empty()).then_some(key));
                        }
                    } else if edit_text(value, key_event) {
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::Probing { choice, .. } => {
                    if cancel {
                        if let Some(abort) = self.unieai_login_abort.write().unwrap().take() {
                            abort.abort();
                        }
                        *state = SelfHostedState::KeyEntry {
                            choice: choice.clone(),
                            value: String::new(),
                        };
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::ModelsFound {
                    choice,
                    api_key,
                    models,
                    filter,
                } => {
                    if cancel {
                        *state = SelfHostedState::KeyEntry {
                            choice: choice.clone(),
                            value: String::new(),
                        };
                        self.set_error(/*message*/ None);
                    } else if confirm {
                        if matching(models, filter).is_empty() {
                            self.set_error(Some(format!(
                                "No model matches \"{}\"; change the filter",
                                filter.trim()
                            )));
                        } else {
                            next = Next::Save {
                                choice: choice.clone(),
                                api_key: api_key.clone(),
                                models: models.clone(),
                                filter: filter.clone(),
                            };
                        }
                    } else if edit_text(filter, key_event) {
                        self.set_error(/*message*/ None);
                    } else {
                        return true;
                    }
                }
                SelfHostedState::Connected { .. } => return false,
            }
        }
        match next {
            Next::Probe(choice, api_key) => self.start_self_hosted_probe(choice, api_key),
            Next::Save {
                choice,
                api_key,
                models,
                filter,
            } => self.save_self_hosted(choice, api_key, models, filter),
            Next::Nothing => self.request_frame.schedule_frame(),
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
                SelfHostedState::UrlEntry { value }
                | SelfHostedState::KeyEntry { value, .. }
                | SelfHostedState::ModelsFound { filter: value, .. },
            ) => value.push_str(trimmed),
            _ => return false,
        }
        drop(guard);
        self.set_error(/*message*/ None);
        self.request_frame.schedule_frame();
        true
    }

    /// Asks the API for its models on a background task: the models step on
    /// success; back to the key step for a refused key (and for a preset,
    /// whose URL is fixed), else to the URL step.
    fn start_self_hosted_probe(&mut self, choice: ApiChoice, api_key: Option<String>) {
        self.set_error(/*message*/ None);
        *self.sign_in_state.write().unwrap() = SignInState::SelfHosted(SelfHostedState::Probing {
            choice: choice.clone(),
        });
        let sign_in_state = self.sign_in_state.clone();
        let error = self.error.clone();
        let request_frame = self.request_frame.clone();
        let join_handle = tokio::spawn(async move {
            let request = choice.request(api_key.clone());
            let next = match codex_login::unieai_self_hosted::probe_api(&request).await {
                Ok(ProbedApi {
                    discovered,
                    base_url,
                }) if !discovered.is_empty() => {
                    *error.write().unwrap() = None;
                    SelfHostedState::ModelsFound {
                        choice: ApiChoice { base_url, ..choice },
                        api_key,
                        models: discovered,
                        filter: String::new(),
                    }
                }
                Ok(ProbedApi { base_url, .. }) => {
                    *error.write().unwrap() = Some(
                        SelfHostedError::NoModels {
                            url: format!("{base_url}/models"),
                        }
                        .to_string(),
                    );
                    back_from_probe(choice)
                }
                Err(err @ SelfHostedError::Unauthorized { .. }) => {
                    *error.write().unwrap() = Some(err.to_string());
                    SelfHostedState::KeyEntry {
                        choice,
                        value: String::new(),
                    }
                }
                Err(err) => {
                    *error.write().unwrap() = Some(err.to_string());
                    back_from_probe(choice)
                }
            };
            *sign_in_state.write().unwrap() = SignInState::SelfHosted(next);
            request_frame.schedule_frame();
        });
        *self.unieai_login_abort.write().unwrap() = Some(join_handle.abort_handle());
        self.request_frame.schedule_frame();
    }

    /// Saves the models matching `filter` (at most [`MAX_STORED_MODELS`]).
    fn save_self_hosted(
        &mut self,
        choice: ApiChoice,
        api_key: Option<String>,
        models: Vec<DiscoveredModel>,
        filter: String,
    ) {
        let request = SelfHostedRequest {
            model_filter: Some(filter),
            ..choice.request(api_key)
        };
        let probe = ProbedApi {
            base_url: choice.base_url.clone(),
            discovered: models,
        };
        match codex_login::unieai_self_hosted::save_probed_api(&self.codex_home, &request, probe) {
            Ok(added) => {
                self.set_error(/*message*/ None);
                let provider = added.provider;
                *self.sign_in_state.write().unwrap() =
                    SignInState::SelfHosted(SelfHostedState::Connected {
                        label: provider.label(),
                        codex_engine: provider.runs_on_codex_engine(),
                        models: provider.models.iter().map(|m| m.id.clone()).collect(),
                        id: provider.id,
                        base_url: provider.base_url,
                        found: added.found,
                    });
            }
            Err(err) => self.set_error(Some(err.to_string())),
        }
        self.request_frame.schedule_frame();
    }

    pub(super) fn render_self_hosted(&self, area: Rect, buf: &mut Buffer, state: &SelfHostedState) {
        match state {
            SelfHostedState::ProviderPick { highlighted } => {
                self.render_provider_pick(area, buf, *highlighted);
            }
            SelfHostedState::UrlEntry { value } => self.render_self_hosted_input(
                area,
                buf,
                vec![
                    "  Connect an OpenAI-compatible server: vLLM, SGLang, TGI, llama.cpp, your"
                        .into(),
                    "  own server, … No UnieAI account is needed.".into(),
                    "".into(),
                    "  Enter its URL (e.g. localhost:8000 or http://gpu-box:8000/v1).".into(),
                ],
                "Server URL",
                (!value.is_empty()).then(|| value.clone()),
                "Paste or type the server URL",
                " to continue",
            ),
            SelfHostedState::KeyEntry { choice, value } => {
                let (prompt, title, placeholder) = if choice.key_required() {
                    (
                        format!("  Paste your {} API key.", choice.label()),
                        "API key",
                        "Paste your API key",
                    )
                } else {
                    (
                        "  Enter its API key, or leave it empty if it needs none.".to_string(),
                        "API key (optional)",
                        "Press Enter without a key if it has none",
                    )
                };
                self.render_self_hosted_input(
                    area,
                    buf,
                    vec![
                        Line::from(format!("  {} · {}", choice.label(), choice.base_url)),
                        "".into(),
                        Line::from(prompt),
                        "  The key is stored owner-only in your UnieAI home.".into(),
                    ],
                    title,
                    // Never echo the key itself.
                    (!value.is_empty()).then(|| "•".repeat(value.chars().count().min(48))),
                    placeholder,
                    " to connect",
                )
            }
            SelfHostedState::Probing { choice, .. } => {
                let lines: Vec<Line> = vec![
                    Line::from(vec!["> ".into(), TITLE.bold()]),
                    "".into(),
                    Line::from(format!(
                        "  Asking {}/models for its models…",
                        choice.base_url
                    ))
                    .dim(),
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
            SelfHostedState::ModelsFound {
                choice,
                models,
                filter,
                ..
            } => self.render_models_found(area, buf, choice, models, filter),
            SelfHostedState::Connected {
                id,
                label,
                base_url,
                models,
                found,
                codex_engine,
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
                let count = if *found > models.len() {
                    format!("{} of {found}", models.len())
                } else {
                    models.len().to_string()
                };
                let engines = if *codex_engine {
                    format!(
                        "  They run on the uac engine; codex can use them too with model_provider = \"{id}\"."
                    )
                } else {
                    "  They run on the uac engine (unieai-agent-core).".to_string()
                };
                let lines: Vec<Line> = vec![
                    format!("✓ Connected {label}").fg(Color::Green).into(),
                    "".into(),
                    Line::from(format!("  Name:    {id} · {base_url}")).dim(),
                    Line::from(format!("  Models:  {count} saved: {shown}")).dim(),
                    "".into(),
                    Line::from(format!(
                        "  Pick one with /model (listed as {id}/<model>, labelled {label})."
                    ))
                    .dim(),
                    Line::from(engines).dim(),
                ];
                Paragraph::new(lines)
                    .wrap(Wrap { trim: false })
                    .render(area, buf);
            }
        }
    }

    fn render_provider_pick(&self, area: Rect, buf: &mut Buffer, highlighted: usize) {
        let mut lines: Vec<Line> = vec![
            Line::from(vec!["> ".into(), TITLE.bold()]),
            "".into(),
            "  Pick the provider. Its URL is filled in; you bring the API key.".into(),
            "  No UnieAI account is needed.".into(),
            "".into(),
        ];
        let entries = API_PRESETS
            .iter()
            .map(|preset| (picker_label(preset), host_of(preset.base_url)))
            .chain(std::iter::once((CUSTOM_LABEL.to_string(), String::new())));
        for (index, (label, host)) in entries.enumerate() {
            let selected = index == highlighted;
            let caret = if selected { ">" } else { " " };
            let number = format!("{caret} {:>2}. ", index + 1);
            let mut spans = if selected {
                vec![number.cyan().dim(), format!("{label:<36}").cyan()]
            } else {
                vec![number.into(), format!("{label:<36}").into()]
            };
            if !host.is_empty() {
                spans.push(format!(" {host}").dim());
            }
            lines.push(Line::from(spans));
        }
        lines.push("".into());
        lines.push(Line::from(vec![
            "  Press ".dim(),
            self.confirm_binding().into(),
            " to continue".dim(),
        ]));
        lines.push(Line::from(vec![
            "  Press ".dim(),
            self.cancel_binding().into(),
            " to go back".dim(),
        ]));
        if let Some(error) = self.error_message() {
            lines.push("".into());
            lines.push(error.red().into());
        }
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .render(area, buf);
    }

    fn render_models_found(
        &self,
        area: Rect,
        buf: &mut Buffer,
        choice: &ApiChoice,
        models: &[DiscoveredModel],
        filter: &str,
    ) {
        let matches = matching(models, filter);
        let kept = matches.len().min(MAX_STORED_MODELS);
        let found = if models.len() > MAX_STORED_MODELS {
            format!(
                "  Found {} models. Up to {MAX_STORED_MODELS} are kept; type to narrow the list.",
                models.len()
            )
        } else {
            format!(
                "  Found {} model{}. Type to narrow the list, or keep them all.",
                models.len(),
                if models.len() == 1 { "" } else { "s" }
            )
        };
        let intro: Vec<Line> = vec![
            Line::from(vec!["> ".into(), TITLE.bold()]),
            "".into(),
            Line::from(format!("  {} · {}", choice.label(), choice.base_url)),
            Line::from(found),
            "".into(),
        ];
        let mut list: Vec<Line> = Vec::new();
        if matches.is_empty() {
            list.push(
                format!("  No model matches \"{}\".", filter.trim())
                    .dim()
                    .into(),
            );
        } else {
            for model in matches.iter().take(MATCHES_SHOWN) {
                let mut notes = Vec::new();
                if let Some(window) = model.context_window {
                    notes.push(if window >= 1000 {
                        format!("{}k", window / 1000)
                    } else {
                        window.to_string()
                    });
                }
                if model.vision {
                    notes.push("vision".to_string());
                }
                let notes = if notes.is_empty() {
                    String::new()
                } else {
                    format!("  ({})", notes.join(", "))
                };
                list.push(Line::from(vec![
                    "  · ".dim(),
                    model.id.clone().into(),
                    notes.dim(),
                ]));
            }
            if matches.len() > MATCHES_SHOWN {
                list.push(
                    format!("    … and {} more", matches.len() - MATCHES_SHOWN)
                        .dim()
                        .into(),
                );
            }
        }
        let [intro_area, input_area, list_area, footer_area] = Layout::vertical([
            Constraint::Length(intro.len() as u16),
            Constraint::Length(3),
            Constraint::Length(list.len() as u16 + 1),
            Constraint::Min(2),
        ])
        .areas(area);
        Paragraph::new(intro)
            .wrap(Wrap { trim: false })
            .render(intro_area, buf);
        let content: Line = if filter.is_empty() {
            vec!["Type part of a model name, e.g. claude or qwen".dim()].into()
        } else {
            Line::from(filter.to_string())
        };
        Paragraph::new(content)
            .block(
                Block::default()
                    .title("Filter (optional)")
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(Color::Cyan)),
            )
            .render(input_area, buf);
        Paragraph::new(list).render(list_area, buf);

        let save = if kept == 0 {
            " to save (no model matches)".to_string()
        } else if matches.len() > kept {
            format!(
                " to save the first {kept} of {} matching models",
                matches.len()
            )
        } else {
            format!(" to save {kept} model{}", if kept == 1 { "" } else { "s" })
        };
        let mut footer: Vec<Line> = vec![
            Line::from(vec![
                "  Press ".dim(),
                self.confirm_binding().into(),
                save.dim(),
            ]),
            Line::from(vec![
                "  Press ".dim(),
                self.cancel_binding().into(),
                " to go back".dim(),
            ]),
        ];
        if let Some(error) = self.error_message() {
            footer.push("".into());
            footer.push(error.red().into());
        }
        Paragraph::new(footer)
            .wrap(Wrap { trim: false })
            .render(footer_area, buf);
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

        let mut intro_lines: Vec<Line> =
            vec![Line::from(vec!["> ".into(), TITLE.bold()]), "".into()];
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

/// Where a failed probe returns: a custom URL to its URL, a preset (whose
/// URL is fixed) to its key.
fn back_from_probe(choice: ApiChoice) -> SelfHostedState {
    match choice.preset {
        Some(_) => SelfHostedState::KeyEntry {
            choice,
            value: String::new(),
        },
        None => SelfHostedState::UrlEntry {
            value: choice.base_url,
        },
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;

    /// The models step for `preset` with `models`, as a probe would leave it.
    pub(in crate::onboarding) fn models_found(
        preset: &str,
        models: Vec<DiscoveredModel>,
    ) -> SelfHostedState {
        let preset = codex_login::unieai_self_hosted::api_preset(preset).expect("preset");
        SelfHostedState::ModelsFound {
            choice: ApiChoice {
                preset: Some(preset),
                base_url: preset.base_url.to_string(),
            },
            api_key: Some("sk-test".to_string()),
            models,
            filter: String::new(),
        }
    }
}
