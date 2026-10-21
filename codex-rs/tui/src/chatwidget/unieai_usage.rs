// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/usage` for a UnieAI Studio login, and live plan usage for both engines.
//!
//! A Studio subscription draws from a 5-hour and a weekly allowance first;
//! past them a request either stops until the window resets or, with the
//! account's opt-in extra usage, bills API credits (docs/unieai/usage-api.md).
//! `/usage` shows that state from Studio's `/api/usage/me` and toggles extra
//! usage. After turns (at most once a minute) the same read is turned into a
//! `codex` rate-limit snapshot, so `/status`, the composer usage notice and the
//! FiveHourLimit / WeeklyLimit status-line items work on uac as on codex,
//! whether or not the gateway sends rate-limit headers.
//!
//! The ChatGPT `/usage` menu (`usage.rs`) is untouched and still serves a
//! ChatGPT login.

use super::*;
use crate::clock_format::ClockFormat;
use chrono::DateTime;
use chrono::Local;
use chrono::Utc;
use codex_app_server_protocol::CreditsSnapshot;
use codex_app_server_protocol::RateLimitWindow;
use codex_login::unieai::UnieAIAccountKind;
use codex_login::unieai_usage::FIVE_HOUR_WINDOW_MINUTES;
use codex_login::unieai_usage::StudioUsage;
use codex_login::unieai_usage::StudioUsageError;
use codex_login::unieai_usage::StudioUsageWindow;
use codex_login::unieai_usage::StudioWallet;
use codex_login::unieai_usage::WEEK_WINDOW_MINUTES;
use codex_login::unieai_usage::unieai_top_up_url;
use ratatui::text::Span;
use std::time::Duration;
use std::time::Instant;

pub(super) const UNIEAI_USAGE_VIEW_ID: &str = "unieai-usage";
/// Live usage is read at most this often.
const LIVE_USAGE_MIN_INTERVAL: Duration = Duration::from_secs(60);
const LABEL_WIDTH: usize = 14;
const BAR_SEGMENTS: usize = 20;

pub(crate) const UNIEAI_USAGE_NO_STUDIO_LOGIN: &str = "/usage shows your UnieAI Studio plan: its 5-hour and weekly limits, extra usage and your wallet. This session isn't signed in to UnieAI Studio (it uses an API key or a self-hosted model, which have no plan usage). Run `unieai login` to sign in.";

/// Results and actions of the Studio usage flow, routed back to the widget.
#[derive(Debug)]
pub(crate) enum UnieAIUsageEvent {
    /// (Re)open the panel and load it.
    Open,
    Loaded {
        request_id: u64,
        load: UnieAIUsageLoad,
    },
    /// A live read after a turn.
    Polled {
        started_at: Instant,
        result: Result<Option<StudioUsage>, StudioUsageError>,
    },
    /// Ask before turning extra usage on; turning it off needs no question.
    ConfirmExtraUsage {
        enable: bool,
    },
    SetExtraUsage {
        enabled: bool,
    },
}

#[derive(Debug)]
pub(crate) enum UnieAIUsageLoad {
    Usage(StudioUsage),
    /// This Studio has no `/api/usage/me` yet (404): the wallet alone.
    Unsupported(Result<Option<StudioWallet>, StudioUsageError>),
    Failed(StudioUsageError),
}

#[derive(Default)]
pub(super) struct UnieAIUsageState {
    next_request_id: u64,
    panel_request_id: Option<u64>,
    poll_in_flight: bool,
    last_poll_at: Option<Instant>,
    /// When the gateway last sent rate-limit headers (a rolling `codex`
    /// snapshot). A Studio read that started before then is older data.
    header_snapshot_at: Option<Instant>,
    /// The "allowance used up" notice was shown for the current exhaustion.
    exhausted_notice_shown: bool,
    #[cfg(test)]
    pub(super) now_override: Option<DateTime<Local>>,
}

enum UsageAccount {
    Studio { studio_url: String },
    Rabi { url: String },
    None,
}

impl ChatWidget {
    fn unieai_usage_account(&self) -> UsageAccount {
        match codex_login::unieai::load_unieai_credentials(&self.config.codex_home) {
            Some(credentials) if credentials.account == UnieAIAccountKind::Studio => {
                UsageAccount::Studio {
                    studio_url: credentials.studio_url,
                }
            }
            Some(credentials) => UsageAccount::Rabi {
                url: credentials.studio_url,
            },
            None => UsageAccount::None,
        }
    }

    fn unieai_usage_now(&self) -> DateTime<Local> {
        #[cfg(test)]
        if let Some(now) = self.unieai_usage.now_override {
            return now;
        }
        Local::now()
    }

    /// `/usage` without a ChatGPT login.
    pub(crate) fn open_unieai_usage(&mut self) {
        match self.unieai_usage_account() {
            UsageAccount::Studio { .. } => {}
            UsageAccount::Rabi { url } => {
                self.add_info_message(
                    format!(
                        "/usage shows UnieAI Studio plan usage, and this session is signed in to UnieAI Rabi. See your Rabi usage at {url}."
                    ),
                    /*hint*/ None,
                );
                return;
            }
            UsageAccount::None => {
                self.add_error_message(UNIEAI_USAGE_NO_STUDIO_LOGIN.to_string());
                return;
            }
        }
        let request_id = self.take_unieai_usage_request_id();
        self.unieai_usage.panel_request_id = Some(request_id);
        let params = self.unieai_usage_message_params(
            vec![Line::from("Loading your plan usage...".dim())],
            /*retry*/ false,
        );
        // Refresh and Try again reopen the panel in place.
        self.bottom_pane.dismiss_view_by_id(UNIEAI_USAGE_VIEW_ID);
        self.bottom_pane.show_selection_view(params);
        self.request_redraw();
        let codex_home = self.config.codex_home.clone();
        self.spawn_unieai_usage_task(async move {
            let load = match codex_login::unieai_usage::fetch_unieai_usage(&codex_home).await {
                Ok(Some(usage)) => UnieAIUsageLoad::Usage(usage),
                Ok(None) => UnieAIUsageLoad::Unsupported(
                    codex_login::unieai_usage::fetch_unieai_wallet(&codex_home).await,
                ),
                Err(err) => UnieAIUsageLoad::Failed(err),
            };
            UnieAIUsageEvent::Loaded { request_id, load }
        });
    }

    pub(crate) fn on_unieai_usage_event(&mut self, event: UnieAIUsageEvent) {
        match event {
            UnieAIUsageEvent::Open => self.open_unieai_usage(),
            UnieAIUsageEvent::Loaded { request_id, load } => {
                self.finish_unieai_usage_load(request_id, load);
            }
            UnieAIUsageEvent::Polled { started_at, result } => {
                self.unieai_usage.poll_in_flight = false;
                if let Ok(Some(usage)) = result {
                    self.apply_studio_usage(&usage, started_at);
                }
            }
            UnieAIUsageEvent::ConfirmExtraUsage { enable } => {
                if enable {
                    self.show_extra_usage_confirmation();
                } else {
                    self.set_unieai_extra_usage(/*enabled*/ false);
                }
            }
            UnieAIUsageEvent::SetExtraUsage { enabled } => self.set_unieai_extra_usage(enabled),
        }
    }

    fn finish_unieai_usage_load(&mut self, request_id: u64, load: UnieAIUsageLoad) {
        if self.unieai_usage.panel_request_id != Some(request_id) {
            return;
        }
        self.unieai_usage.panel_request_id = None;
        let studio_url = match self.unieai_usage_account() {
            UsageAccount::Studio { studio_url } => studio_url,
            UsageAccount::Rabi { .. } | UsageAccount::None => {
                self.bottom_pane.dismiss_view_by_id(UNIEAI_USAGE_VIEW_ID);
                return;
            }
        };
        if let UnieAIUsageLoad::Usage(usage) = &load {
            self.apply_studio_usage(usage, Instant::now());
        }
        let params = self.unieai_usage_panel_params(&load, &studio_url);
        if self
            .bottom_pane
            .replace_selection_view_if_present(UNIEAI_USAGE_VIEW_ID, params)
        {
            self.request_redraw();
        }
    }

    fn unieai_usage_panel_params(
        &self,
        load: &UnieAIUsageLoad,
        studio_url: &str,
    ) -> SelectionViewParams {
        let now = self.unieai_usage_now();
        match load {
            UnieAIUsageLoad::Usage(usage) => self.unieai_usage_data_params(usage, studio_url, now),
            UnieAIUsageLoad::Unsupported(wallet) => {
                let mut lines = vec![Line::from(
                    "Plan usage isn't available from this Studio yet.".to_string(),
                )];
                match wallet {
                    Ok(Some(wallet)) => {
                        lines.push(Line::default());
                        lines.extend(wallet_lines(wallet, now));
                    }
                    Ok(None) => {}
                    Err(err) => {
                        lines.push(Line::default());
                        lines.push(Line::from(format!("Wallet unavailable: {err}").dim()));
                    }
                }
                let mut params = self.unieai_usage_message_params(lines, /*retry*/ false);
                params.items = vec![
                    link_item("Top up credits", unieai_top_up_url(studio_url)),
                    refresh_item(),
                ];
                params
            }
            UnieAIUsageLoad::Failed(err) => self.unieai_usage_message_params(
                vec![Line::from(format!("Couldn't load your plan usage. {err}"))],
                /*retry*/ true,
            ),
        }
    }

    fn unieai_usage_data_params(
        &self,
        usage: &StudioUsage,
        studio_url: &str,
        now: DateTime<Local>,
    ) -> SelectionViewParams {
        let lines = usage_panel_lines(usage, now, self.clock_format);
        let mut items = Vec::new();
        if usage.plan.is_some() {
            let enabled = usage.extra_usage.enabled;
            items.push(SelectionItem {
                name: format!("Extra usage: {}", if enabled { "On" } else { "Off" }),
                description: Some(if enabled {
                    "Turn off to stop at plan limits instead of billing credits".to_string()
                } else {
                    "Turn on to keep going on API credits after a plan limit".to_string()
                }),
                actions: vec![Box::new(move |tx| {
                    tx.send(AppEvent::UnieAIUsage(UnieAIUsageEvent::ConfirmExtraUsage {
                        enable: !enabled,
                    }));
                })],
                ..Default::default()
            });
            items.push(link_item("Manage plan", usage.manage_url(studio_url)));
        }
        items.push(link_item("Top up credits", usage.top_up_url(studio_url)));
        items.push(refresh_item());
        SelectionViewParams {
            view_id: Some(UNIEAI_USAGE_VIEW_ID),
            header: Box::new(Paragraph::new(lines).wrap(Wrap { trim: false })),
            footer_hint: Some(super::usage::usage_hint_line(
                &self.bottom_pane.list_keymap(),
                "select",
            )),
            items,
            ..SelectionViewParams::picker()
        }
    }

    /// A panel holding a message: loading, a failure (with Try again), or
    /// saving.
    fn unieai_usage_message_params(
        &self,
        body: Vec<Line<'static>>,
        retry: bool,
    ) -> SelectionViewParams {
        let mut lines = vec![usage_title_line(None), Line::default()];
        lines.extend(body);
        let items = if retry {
            vec![
                SelectionItem {
                    name: "Try again".to_string(),
                    actions: vec![Box::new(|tx| {
                        tx.send(AppEvent::UnieAIUsage(UnieAIUsageEvent::Open));
                    })],
                    ..Default::default()
                },
                SelectionItem {
                    name: "Close".to_string(),
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ]
        } else {
            vec![SelectionItem {
                name: "Close".to_string(),
                dismiss_on_select: true,
                ..Default::default()
            }]
        };
        SelectionViewParams {
            view_id: Some(UNIEAI_USAGE_VIEW_ID),
            header: Box::new(Paragraph::new(lines).wrap(Wrap { trim: false })),
            footer_hint: Some(super::usage::usage_hint_line(
                &self.bottom_pane.list_keymap(),
                "select",
            )),
            items,
            ..SelectionViewParams::picker()
        }
    }

    /// The question replaces the panel; either answer brings the panel back.
    fn show_extra_usage_confirmation(&mut self) {
        let params = SelectionViewParams {
            view_id: Some(UNIEAI_USAGE_VIEW_ID),
            header: Box::new(
                Paragraph::new(vec![
                    Line::from("Turn on extra usage?".bold()),
                    Line::default(),
                    Line::from(
                        "When your 5-hour or weekly plan limit is reached, requests keep going and are billed to your API credits (grants first, then your wallet) instead of stopping until the limit resets."
                            .dim(),
                    ),
                    Line::default(),
                    Line::from("Your wallet's monthly spending limit still applies.".dim()),
                ])
                .wrap(Wrap { trim: false }),
            ),
            footer_hint: Some(super::usage::usage_hint_line(
                &self.bottom_pane.list_keymap(),
                "confirm",
            )),
            items: vec![
                SelectionItem {
                    name: "Turn on extra usage".to_string(),
                    description: Some("Bill API credits after the plan allowance".to_string()),
                    actions: vec![Box::new(|tx| {
                        tx.send(AppEvent::UnieAIUsage(UnieAIUsageEvent::SetExtraUsage {
                            enabled: true,
                        }));
                    })],
                    ..Default::default()
                },
                SelectionItem {
                    name: "Cancel".to_string(),
                    description: Some("Keep stopping at plan limits".to_string()),
                    actions: vec![Box::new(|tx| {
                        tx.send(AppEvent::UnieAIUsage(UnieAIUsageEvent::Open));
                    })],
                    ..Default::default()
                },
            ],
            initial_selected_idx: Some(1),
            ..SelectionViewParams::picker()
        };
        if self
            .bottom_pane
            .replace_selection_view_if_present(UNIEAI_USAGE_VIEW_ID, params)
        {
            self.request_redraw();
        }
    }

    fn set_unieai_extra_usage(&mut self, enabled: bool) {
        if !matches!(self.unieai_usage_account(), UsageAccount::Studio { .. }) {
            return;
        }
        let request_id = self.take_unieai_usage_request_id();
        self.unieai_usage.panel_request_id = Some(request_id);
        let saving = self.unieai_usage_message_params(
            vec![Line::from(
                format!(
                    "Turning extra usage {}...",
                    if enabled { "on" } else { "off" }
                )
                .dim(),
            )],
            /*retry*/ false,
        );
        if !self
            .bottom_pane
            .replace_selection_view_if_present(UNIEAI_USAGE_VIEW_ID, saving)
        {
            return;
        }
        self.request_redraw();
        let codex_home = self.config.codex_home.clone();
        self.spawn_unieai_usage_task(async move {
            let load = match codex_login::unieai_usage::set_unieai_extra_usage(&codex_home, enabled)
                .await
            {
                Ok(usage) => UnieAIUsageLoad::Usage(usage),
                Err(err) => UnieAIUsageLoad::Failed(err),
            };
            UnieAIUsageEvent::Loaded { request_id, load }
        });
    }

    /// After a turn: read plan usage for /status and the status line, at most
    /// once a minute, when signed in to Studio.
    pub(super) fn maybe_poll_unieai_usage(&mut self) {
        if self.has_codex_backend_auth || self.unieai_usage.poll_in_flight {
            return;
        }
        if self
            .unieai_usage
            .last_poll_at
            .is_some_and(|at| at.elapsed() < LIVE_USAGE_MIN_INTERVAL)
        {
            return;
        }
        if !matches!(self.unieai_usage_account(), UsageAccount::Studio { .. }) {
            return;
        }
        let started_at = Instant::now();
        self.unieai_usage.poll_in_flight = true;
        self.unieai_usage.last_poll_at = Some(started_at);
        let codex_home = self.config.codex_home.clone();
        self.spawn_unieai_usage_task(async move {
            UnieAIUsageEvent::Polled {
                started_at,
                result: codex_login::unieai_usage::fetch_unieai_usage(&codex_home).await,
            }
        });
    }

    /// The gateway refused a turn for billing: read usage now so /status and
    /// the status line show the exhausted window. The error already said what
    /// happened, so the read does not repeat it as a notice.
    pub(super) fn refresh_unieai_usage_after_limit_error(&mut self) {
        self.unieai_usage.exhausted_notice_shown = true;
        self.unieai_usage.last_poll_at = None;
        self.maybe_poll_unieai_usage();
    }

    /// The gateway sent rate-limit headers for a Studio login: they are the
    /// fresher reading, and a Studio read already in flight must not replace
    /// them. Returns whether this is a Studio login's `codex` limit.
    pub(super) fn note_unieai_rate_limit_headers(&mut self, snapshot: &RateLimitSnapshot) -> bool {
        let is_codex_limit = snapshot
            .limit_id
            .as_deref()
            .is_none_or(|limit_id| limit_id.eq_ignore_ascii_case("codex"));
        if !is_codex_limit || !matches!(self.unieai_usage_account(), UsageAccount::Studio { .. }) {
            return false;
        }
        self.unieai_usage.header_snapshot_at = Some(Instant::now());
        true
    }

    /// Feed a Studio usage read to /status, the status line and the usage
    /// notices, unless the gateway's headers reported after it started.
    fn apply_studio_usage(&mut self, usage: &StudioUsage, started_at: Instant) {
        let headers_are_newer = self
            .unieai_usage
            .header_snapshot_at
            .is_some_and(|at| at >= started_at);
        if !headers_are_newer {
            // Percentages from either source are absolute readings of the same
            // windows: the snapshot replaces, it never adds.
            self.on_rate_limit_snapshot(Some(studio_rate_limit_snapshot(usage)));
        }
        self.update_plan_exhausted_notice(usage);
    }

    fn update_plan_exhausted_notice(&mut self, usage: &StudioUsage) {
        let exhausted = [
            (usage.windows.five_hour.as_ref(), "5-hour"),
            (usage.windows.week.as_ref(), "weekly"),
        ]
        .into_iter()
        .filter_map(|(window, label)| Some((window?, label)))
        .filter(|(window, _)| window.is_exhausted())
        .max_by_key(|(window, _)| window.resets_at);
        let Some((window, label)) = exhausted else {
            self.unieai_usage.exhausted_notice_shown = false;
            return;
        };
        if self.unieai_usage.exhausted_notice_shown {
            return;
        }
        self.unieai_usage.exhausted_notice_shown = true;
        let now = self.unieai_usage_now();
        let resets = window
            .resets_at
            .map(|at| {
                format!(
                    " resets at {}",
                    crate::status::format_reset_timestamp(
                        at.with_timezone(&Local),
                        now,
                        self.clock_format
                    )
                )
            })
            .unwrap_or_default();
        if usage.extra_usage.enabled && usage.credits_available() {
            self.add_info_message(
                "Plan allowance used up — now using API credits.".to_string(),
                Some(format!(
                    "Your {label} limit{}. /usage shows your balance.",
                    if resets.is_empty() {
                        " resets later".to_string()
                    } else {
                        resets
                    }
                )),
            );
        } else if usage.extra_usage.enabled {
            self.add_to_history(history_cell::new_usage_warning_event(format!(
                "Plan limit reached and your API credits are empty. Top up in /usage, or wait: your {label} limit{}.",
                if resets.is_empty() {
                    " resets later".to_string()
                } else {
                    resets
                }
            )));
        } else {
            self.add_to_history(history_cell::new_usage_warning_event(format!(
                "Plan limit reached — your {label} limit{}. Turn on extra usage in /usage to keep going on API credits.",
                if resets.is_empty() {
                    " resets later".to_string()
                } else {
                    resets
                }
            )));
        }
        self.request_redraw();
    }

    fn take_unieai_usage_request_id(&mut self) -> u64 {
        self.unieai_usage.next_request_id = self.unieai_usage.next_request_id.wrapping_add(1);
        self.unieai_usage.next_request_id
    }

    fn spawn_unieai_usage_task(
        &self,
        task: impl std::future::Future<Output = UnieAIUsageEvent> + Send + 'static,
    ) {
        let tx = self.app_event_tx.clone();
        tokio::spawn(async move {
            tx.send(AppEvent::UnieAIUsage(task.await));
        });
    }

    #[cfg(test)]
    pub(super) fn unieai_usage_panel_request_id(&self) -> Option<u64> {
        self.unieai_usage.panel_request_id
    }

    #[cfg(test)]
    pub(super) fn unieai_usage_poll_in_flight(&self) -> bool {
        self.unieai_usage.poll_in_flight
    }
}

/// The `codex` limit the status surfaces read: primary is the 5-hour window,
/// secondary the weekly one. Credits count as usable only with extra usage
/// on, so the near-limit warnings stay quiet only when going past the limit
/// would not stop the user.
pub(super) fn studio_rate_limit_snapshot(usage: &StudioUsage) -> RateLimitSnapshot {
    let window = |window: Option<&StudioUsageWindow>, default_minutes: i64| {
        let window = window?;
        Some(RateLimitWindow {
            used_percent: window.used_percent()?.round().clamp(0.0, 100.0) as i32,
            window_duration_mins: Some(window.window_minutes.unwrap_or(default_minutes)),
            resets_at: window.resets_at.map(|at| at.timestamp()),
        })
    };
    RateLimitSnapshot {
        limit_id: Some("codex".to_string()),
        limit_name: None,
        normal_model_slug: None,
        primary: window(usage.windows.five_hour.as_ref(), FIVE_HOUR_WINDOW_MINUTES),
        secondary: window(usage.windows.week.as_ref(), WEEK_WINDOW_MINUTES),
        credits: usage.wallet.is_some().then(|| CreditsSnapshot {
            has_credits: usage.extra_usage.enabled && usage.credits_available(),
            unlimited: false,
            // /status would print a dollar balance as "N credits"; the exact
            // amount is in /usage.
            balance: None,
        }),
        individual_limit: None,
        spend_control_reached: None,
        plan_type: None,
        rate_limit_reached_type: None,
    }
}

fn usage_title_line(plan: Option<String>) -> Line<'static> {
    let mut spans = vec!["Usage".bold(), " · UnieAI Studio".dim()];
    if let Some(plan) = plan {
        spans.push(" · ".dim());
        spans.push(plan.into());
    }
    Line::from(spans)
}

fn labeled(label: &str, value: Vec<Span<'static>>) -> Line<'static> {
    let mut spans = vec![format!("{label:<LABEL_WIDTH$}").dim()];
    spans.extend(value);
    Line::from(spans)
}

/// The panel body: plan, both windows, extra usage, grants and the wallet.
pub(super) fn usage_panel_lines(
    usage: &StudioUsage,
    now: DateTime<Local>,
    clock_format: ClockFormat,
) -> Vec<Line<'static>> {
    let plan = usage.plan.as_ref().map(|plan| {
        let mut name = format!("{} plan", plan.display_name());
        if let Some(status) = plan
            .status
            .as_deref()
            .filter(|status| !status.eq_ignore_ascii_case("active"))
        {
            name.push_str(&format!(" ({status})"));
        }
        name
    });
    let mut lines = vec![usage_title_line(plan), Line::default()];
    if usage.plan.is_none() {
        lines.push(Line::from(
            "No plan: every request is billed to your wallet.".to_string(),
        ));
    } else {
        let windows = [
            ("5-hour limit", usage.windows.five_hour.as_ref()),
            ("Weekly limit", usage.windows.week.as_ref()),
        ];
        if windows.iter().all(|(_, window)| window.is_none()) {
            lines.push(Line::from(
                "This plan has no 5-hour or weekly limit.".to_string(),
            ));
        }
        for (label, window) in windows {
            if let Some(window) = window {
                lines.push(labeled(label, window_spans(window, now, clock_format)));
            }
        }
        lines.push(labeled(
            "Extra usage",
            if usage.extra_usage.enabled {
                vec![
                    "On".green().bold(),
                    " · past a limit, requests bill your API credits".dim(),
                ]
            } else {
                vec![
                    "Off".bold(),
                    " · requests stop at a limit until it resets".dim(),
                ]
            },
        ));
    }
    if !usage.grants.is_empty() {
        lines.push(Line::default());
        for (index, grant) in usage.grants.iter().enumerate() {
            let label = if index == 0 { "Credits" } else { "" };
            let mut value = vec![
                format!("{} ", grant.label).into(),
                format_usd(grant.remaining_usd()).bold(),
            ];
            if let Some(expires_at) = grant.expires_at {
                value.push(format!(" · expires {}", format_date(expires_at, now)).dim());
            }
            lines.push(labeled(label, value));
        }
    }
    if let Some(wallet) = &usage.wallet {
        if usage.grants.is_empty() {
            lines.push(Line::default());
        }
        lines.extend(wallet_lines(wallet, now));
    }
    lines
}

fn window_spans(
    window: &StudioUsageWindow,
    now: DateTime<Local>,
    clock_format: ClockFormat,
) -> Vec<Span<'static>> {
    let Some(used) = window.used_percent() else {
        return vec!["Unlimited".into()];
    };
    // The bar fills with what is used, like the percentage beside it.
    let bar = crate::status::render_limit_progress_bar(used, BAR_SEGMENTS);
    let percent = format!(" {:.0}% used", used.min(999.0));
    let mut spans = vec![
        bar.into(),
        if used >= 100.0 {
            percent.red().bold()
        } else if used >= 90.0 {
            percent.bold()
        } else {
            percent.into()
        },
    ];
    if let Some(resets_at) = window.resets_at {
        let local = resets_at.with_timezone(&Local);
        if local > now {
            spans.push(
                format!(
                    " · resets in {} ({})",
                    format_duration(local - now),
                    crate::status::format_reset_timestamp(local, now, clock_format)
                )
                .dim(),
            );
        }
    }
    spans
}

fn wallet_lines(wallet: &StudioWallet, now: DateTime<Local>) -> Vec<Line<'static>> {
    let mut lines = vec![labeled(
        "Wallet",
        vec![format_usd(wallet.balance_usd()).bold(), " available".into()],
    )];
    let spent = wallet.monthly_spent_usd.unwrap_or(0.0);
    let mut monthly = match (wallet.monthly_limit_usd, wallet.monthly_remaining()) {
        (Some(limit), Some(left)) => vec![
            format!(
                "Limit {} · {} spent · ",
                format_usd(limit),
                format_usd(spent)
            )
            .into(),
            format!("{} left", format_usd(left)).bold(),
        ],
        _ => vec![format!("No limit · {} spent", format_usd(spent)).into()],
    };
    if let Some(period_end) = wallet.period_end {
        monthly.push(format!(" · resets {}", format_date(period_end, now)).dim());
    }
    lines.push(labeled("This month", monthly));
    lines
}

fn link_item(name: &str, url: String) -> SelectionItem {
    SelectionItem {
        name: name.to_string(),
        description: Some(url.clone()),
        actions: vec![Box::new(move |tx| {
            tx.send(AppEvent::OpenUrlInBrowser { url: url.clone() });
        })],
        ..Default::default()
    }
}

fn refresh_item() -> SelectionItem {
    SelectionItem {
        name: "Refresh".to_string(),
        actions: vec![Box::new(|tx| {
            tx.send(AppEvent::UnieAIUsage(UnieAIUsageEvent::Open));
        })],
        ..Default::default()
    }
}

fn format_usd(amount: f64) -> String {
    format!("${amount:.2}")
}

fn format_date(at: DateTime<Utc>, now: DateTime<Local>) -> String {
    let local = at.with_timezone(&Local);
    if local.format("%Y").to_string() == now.format("%Y").to_string() {
        local.format("%-d %b").to_string()
    } else {
        local.format("%-d %b %Y").to_string()
    }
}

fn format_duration(duration: chrono::TimeDelta) -> String {
    let minutes = duration.num_minutes().max(0);
    let (days, hours, minutes) = (minutes / (24 * 60), (minutes / 60) % 24, minutes % 60);
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        "<1m".to_string()
    }
}
