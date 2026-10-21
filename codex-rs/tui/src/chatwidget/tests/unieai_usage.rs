// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/usage` for a UnieAI Studio login and live plan usage.

use super::super::unieai_usage::UnieAIUsageEvent;
use super::super::unieai_usage::UnieAIUsageLoad;
use super::super::unieai_usage::studio_rate_limit_snapshot;
use super::*;
use chrono::TimeZone;
use codex_login::unieai::UnieAIAccountKind;
use codex_login::unieai::UnieAICredentials;
use codex_login::unieai_usage::StudioUsage;
use codex_login::unieai_usage::StudioUsageError;
use codex_login::unieai_usage::StudioWallet;
use codex_login::unieai_usage::parse_studio_usage;
use pretty_assertions::assert_eq;

/// Studio is never reached in these tests: the load results are fed by hand.
const STUDIO_URL: &str = "http://127.0.0.1:9";

fn sign_in(chat: &ChatWidget, account: UnieAIAccountKind) {
    codex_login::unieai::save_unieai_credentials(
        &chat.config.codex_home,
        &UnieAICredentials {
            account,
            studio_url: STUDIO_URL.to_string(),
            access_token: "access".to_string(),
            refresh_token: "refresh".to_string(),
            expires_at: i64::MAX / 2,
            email: None,
            active_org_id: None,
            gateway_base_url: format!("{STUDIO_URL}/v1"),
            gateway_api_key: "gw".to_string(),
            gateway_base_url_locked: false,
            available_model_ids: None,
            available_models: None,
        },
    )
    .expect("save credentials");
}

fn now() -> chrono::DateTime<Local> {
    Local
        .with_ymd_and_hms(2026, 10, 20, 12, 0, 0)
        .single()
        .expect("local time")
}

fn iso(at: chrono::DateTime<Local>) -> String {
    at.with_timezone(&chrono::Utc).to_rfc3339()
}

fn usage(five_hour_used: i64, extra_usage: bool) -> StudioUsage {
    let now = now();
    parse_studio_usage(serde_json::json!({
        "plan": {"key": "pro", "name": "Pro", "status": "active"},
        "windows": {
            "fiveHour": {
                "usedMicroUsd": five_hour_used,
                "limitMicroUsd": 5_000_000,
                "resetsAt": iso(now + chrono::Duration::minutes(130)),
            },
            "week": {
                "usedMicroUsd": 12_000_000,
                "limitMicroUsd": 40_000_000,
                "resetsAt": iso(now + chrono::Duration::hours(132)),
            }
        },
        "extraUsage": {"enabled": extra_usage},
        "grants": [{
            "label": "Welcome credit",
            "remainingMicroUsd": 2_000_000,
            "expiresAt": iso(now + chrono::Duration::days(41)),
        }],
        "wallet": {
            "availableMicroUsd": 18_250_000,
            "monthlyLimitUsd": 50,
            "monthlySpentUsd": 7.5,
            "periodEnd": iso(now + chrono::Duration::days(12)),
        },
        "links": {
            "manage": "https://agent.unieai.com/settings/subscription",
            "topUp": "http://127.0.0.1:9/plan"
        }
    }))
    .expect("usage")
}

async fn studio_chat() -> (ChatWidget, tokio::sync::mpsc::UnboundedReceiver<AppEvent>) {
    let (mut chat, rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    std::fs::create_dir_all(&chat.config.codex_home).expect("codex home");
    sign_in(&chat, UnieAIAccountKind::Studio);
    chat.unieai_usage.now_override = Some(now());
    chat.clock_format = crate::clock_format::ClockFormat::TwentyFourHour;
    (chat, rx)
}

fn open_and_load(chat: &mut ChatWidget, load: UnieAIUsageLoad) {
    chat.dispatch_command(SlashCommand::Usage);
    let request_id = chat
        .unieai_usage_panel_request_id()
        .expect("a load in flight");
    chat.on_unieai_usage_event(UnieAIUsageEvent::Loaded { request_id, load });
}

fn history_text(rx: &mut tokio::sync::mpsc::UnboundedReceiver<AppEvent>) -> String {
    drain_insert_history(rx)
        .iter()
        .map(|cell| lines_to_single_string(cell))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn unieai_usage_without_a_studio_login_says_what_it_needs() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    chat.dispatch_command(SlashCommand::Usage);
    assert_chatwidget_snapshot!("unieai_usage_without_studio_login", history_text(&mut rx));
}

#[tokio::test]
async fn unieai_usage_with_a_rabi_login_points_to_rabi() {
    let (mut chat, mut rx, _op_rx) = make_chatwidget_manual(/*model_override*/ None).await;
    std::fs::create_dir_all(&chat.config.codex_home).expect("codex home");
    sign_in(&chat, UnieAIAccountKind::Rabi);
    chat.dispatch_command(SlashCommand::Usage);
    let rendered = history_text(&mut rx);
    assert!(rendered.contains("signed in to UnieAI Rabi"), "{rendered}");
    assert_eq!(chat.unieai_usage_panel_request_id(), None);
}

#[tokio::test]
async fn unieai_usage_shows_loading_then_the_plan() {
    let (mut chat, _rx) = studio_chat().await;
    chat.dispatch_command(SlashCommand::Usage);
    assert_chatwidget_snapshot!("unieai_usage_loading", render_bottom_popup(&chat, 90));

    let request_id = chat.unieai_usage_panel_request_id().expect("loading");
    chat.on_unieai_usage_event(UnieAIUsageEvent::Loaded {
        request_id,
        load: UnieAIUsageLoad::Usage(usage(3_100_000, /*extra_usage*/ false)),
    });
    assert_chatwidget_snapshot!("unieai_usage_panel", render_bottom_popup(&chat, 90));
}

#[tokio::test]
async fn unieai_usage_panel_with_extra_usage_on_and_an_exhausted_window() {
    let (mut chat, _rx) = studio_chat().await;
    open_and_load(
        &mut chat,
        UnieAIUsageLoad::Usage(usage(5_000_000, /*extra_usage*/ true)),
    );
    assert_chatwidget_snapshot!(
        "unieai_usage_panel_extra_usage_on",
        render_bottom_popup(&chat, 90)
    );
}

#[tokio::test]
async fn unieai_usage_on_a_studio_without_plan_usage_shows_the_wallet() {
    let (mut chat, _rx) = studio_chat().await;
    let wallet: StudioWallet = serde_json::from_value(serde_json::json!({
        "availableMicroUsd": 4_200_000,
        "monthlyLimitUsd": null,
        "monthlySpentUsd": 3.1,
        "periodEnd": iso(now() + chrono::Duration::days(12)),
    }))
    .expect("wallet");
    open_and_load(&mut chat, UnieAIUsageLoad::Unsupported(Ok(Some(wallet))));
    assert_chatwidget_snapshot!(
        "unieai_usage_unsupported_studio",
        render_bottom_popup(&chat, 90)
    );
}

#[tokio::test]
async fn unieai_usage_failure_offers_a_retry() {
    let (mut chat, mut rx) = studio_chat().await;
    open_and_load(
        &mut chat,
        UnieAIUsageLoad::Failed(StudioUsageError::Unauthorized),
    );
    assert_chatwidget_snapshot!("unieai_usage_failed", render_bottom_popup(&chat, 90));
    // Try again reloads.
    while rx.try_recv().is_ok() {}
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    assert_matches!(
        rx.try_recv(),
        Ok(AppEvent::UnieAIUsage(UnieAIUsageEvent::Open))
    );
}

#[tokio::test]
async fn turning_extra_usage_on_asks_first() {
    let (mut chat, mut rx) = studio_chat().await;
    open_and_load(
        &mut chat,
        UnieAIUsageLoad::Usage(usage(3_100_000, /*extra_usage*/ false)),
    );
    while rx.try_recv().is_ok() {}
    // The first row is the extra usage toggle.
    chat.handle_key_event(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
    let event = loop {
        match rx.try_recv() {
            Ok(AppEvent::UnieAIUsage(event)) => break event,
            Ok(_) => continue,
            Err(err) => panic!("no usage event: {err:?}"),
        }
    };
    assert_matches!(event, UnieAIUsageEvent::ConfirmExtraUsage { enable: true });
    chat.on_unieai_usage_event(event);
    assert_chatwidget_snapshot!(
        "unieai_usage_extra_usage_confirmation",
        render_bottom_popup(&chat, 90)
    );
}

#[tokio::test]
async fn studio_usage_feeds_the_five_hour_and_weekly_status_items() {
    let (mut chat, _rx) = studio_chat().await;
    let snapshot = studio_rate_limit_snapshot(&usage(3_100_000, /*extra_usage*/ false));
    assert_eq!(snapshot.limit_id.as_deref(), Some("codex"));
    assert_eq!(
        snapshot
            .primary
            .as_ref()
            .map(|window| (window.used_percent, window.window_duration_mins)),
        Some((62, Some(300)))
    );
    assert_eq!(
        snapshot
            .secondary
            .as_ref()
            .map(|window| (window.used_percent, window.window_duration_mins)),
        Some((30, Some(10080)))
    );
    // Extra usage off: credits do not keep the user going past a limit.
    assert_eq!(
        snapshot.credits.as_ref().map(|c| c.has_credits),
        Some(false)
    );

    open_and_load(
        &mut chat,
        UnieAIUsageLoad::Usage(usage(3_100_000, /*extra_usage*/ false)),
    );
    let five_hour = chat
        .status_line_value_for_item(crate::bottom_pane::StatusLineItem::FiveHourLimit)
        .expect("five hour item");
    let weekly = chat
        .status_line_value_for_item(crate::bottom_pane::StatusLineItem::WeeklyLimit)
        .expect("weekly item");
    assert!(five_hour.starts_with("5h"), "{five_hour}");
    assert!(weekly.starts_with("weekly"), "{weekly}");
}

#[tokio::test]
async fn gateway_headers_newer_than_a_studio_read_win() {
    let (mut chat, _rx) = studio_chat().await;
    let started_at = std::time::Instant::now();
    // The gateway reported 80% after the read began.
    chat.on_rolling_rate_limit_snapshot(RateLimitSnapshot {
        primary: Some(codex_app_server_protocol::RateLimitWindow {
            used_percent: 80,
            window_duration_mins: Some(300),
            resets_at: None,
        }),
        ..studio_rate_limit_snapshot(&usage(0, /*extra_usage*/ false))
    });
    chat.on_unieai_usage_event(UnieAIUsageEvent::Polled {
        started_at,
        result: Ok(Some(usage(3_100_000, /*extra_usage*/ false))),
    });
    let primary = chat
        .rate_limit_snapshots_by_limit_id
        .get("codex")
        .and_then(|display| display.primary.as_ref())
        .map(|window| window.used_percent);
    assert_eq!(primary, Some(80.0));
}

#[tokio::test]
async fn crossing_the_allowance_with_extra_usage_on_says_credits_are_in_use_once() {
    let (mut chat, mut rx) = studio_chat().await;
    let poll = |chat: &mut ChatWidget, used: i64| {
        chat.on_unieai_usage_event(UnieAIUsageEvent::Polled {
            started_at: std::time::Instant::now(),
            result: Ok(Some(usage(used, /*extra_usage*/ true))),
        });
    };
    poll(&mut chat, 4_000_000);
    poll(&mut chat, 5_000_000);
    poll(&mut chat, 5_100_000);
    let rendered = history_text(&mut rx);
    assert_eq!(
        rendered
            .matches("Plan allowance used up — now using API credits.")
            .count(),
        1,
        "{rendered}"
    );
}

#[tokio::test]
async fn crossing_the_allowance_with_extra_usage_off_says_when_it_resets() {
    let (mut chat, mut rx) = studio_chat().await;
    chat.on_unieai_usage_event(UnieAIUsageEvent::Polled {
        started_at: std::time::Instant::now(),
        result: Ok(Some(usage(5_000_000, /*extra_usage*/ false))),
    });
    assert_chatwidget_snapshot!(
        "unieai_usage_plan_limit_reached_notice",
        history_text(&mut rx)
    );
}

#[tokio::test]
async fn live_usage_is_read_at_most_once_a_minute() {
    let (mut chat, _rx) = studio_chat().await;
    chat.maybe_poll_unieai_usage();
    assert!(chat.unieai_usage_poll_in_flight());
    chat.on_unieai_usage_event(UnieAIUsageEvent::Polled {
        started_at: std::time::Instant::now(),
        result: Err(StudioUsageError::Status { status: 500 }),
    });
    chat.maybe_poll_unieai_usage();
    assert!(!chat.unieai_usage_poll_in_flight(), "debounced");
}
