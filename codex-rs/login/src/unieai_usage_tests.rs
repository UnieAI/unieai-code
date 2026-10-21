// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::unieai::save_unieai_credentials;
use pretty_assertions::assert_eq;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

fn usage_body() -> Value {
    json!({
        "plan": {"key": "pro", "name": "Pro", "status": "active"},
        "windows": {
            "fiveHour": {"usedMicroUsd": 3_100_000, "limitMicroUsd": 5_000_000, "resetsAt": "2026-10-20T15:00:00.000Z"},
            "week": {"usedMicroUsd": 12_000_000, "limitMicroUsd": null, "resetsAt": null}
        },
        "extraUsage": {"enabled": true},
        "grants": [{"label": "Welcome credit", "remainingMicroUsd": 2_000_000, "expiresAt": "2026-11-30T00:00:00Z"}],
        "wallet": {"availableMicroUsd": 18_250_000, "monthlyLimitUsd": 50, "monthlySpentUsd": 7.5, "periodEnd": "2026-11-01T00:00:00.000Z"},
        "links": {"manage": "https://agent.unieai.com/settings/subscription", "topUp": "https://studio.example/plan"}
    })
}

#[test]
fn parses_the_usage_contract() {
    let usage = parse_studio_usage(usage_body()).expect("parse");
    assert_eq!(usage.plan.as_ref().map(StudioPlan::display_name), Some("Pro"));
    let five_hour = usage.windows.five_hour.as_ref().expect("five hour");
    assert_eq!(five_hour.used_percent(), Some(62.0));
    assert_eq!(
        five_hour.resets_at,
        DateTime::parse_from_rfc3339("2026-10-20T15:00:00Z")
            .ok()
            .map(|time| time.with_timezone(&Utc))
    );
    let week = usage.windows.week.as_ref().expect("week");
    assert_eq!(week.used_percent(), None, "a null limit is unlimited");
    assert!(usage.extra_usage.enabled);
    assert_eq!(usage.grants[0].remaining_usd(), 2.0);
    let wallet = usage.wallet.as_ref().expect("wallet");
    assert_eq!(wallet.balance_usd(), 18.25);
    assert_eq!(wallet.monthly_remaining(), Some(42.5));
    assert!(usage.credits_available());
    assert_eq!(
        usage.top_up_url("https://studio.other"),
        "https://studio.example/plan"
    );
}

#[test]
fn tolerates_envelopes_missing_fields_and_odd_numbers() {
    let usage = parse_studio_usage(json!({
        "request_id": "req_1",
        "data": {
            "plan": null,
            "windows": {"fiveHour": {"usedMicroUsd": "250000", "limitMicroUsd": 1000000.0, "resetsAt": "not a date"}},
            "grants": null
        }
    }))
    .expect("parse");
    assert_eq!(usage.plan, None);
    let five_hour = usage.windows.five_hour.clone().expect("five hour");
    assert_eq!(five_hour.used_percent(), Some(25.0));
    assert_eq!(five_hour.resets_at, None);
    assert_eq!(usage.windows.week, None);
    assert!(!usage.extra_usage.enabled, "absent extra usage is off");
    assert!(usage.grants.is_empty());
    assert!(!usage.credits_available());
    assert_eq!(
        usage.top_up_url("https://studio.example/"),
        "https://studio.example/plan"
    );
}

#[test]
fn parses_wallet_me() {
    // The shape of UnieAI-Studio's app/api/wallet/me/route.ts.
    let wallet = parse_studio_wallet(json!({
        "request_id": "req_2",
        "data": {
            "userId": "u1", "currency": "USD",
            "availableMicroUsd": 0, "availableUsd": 0, "reservedMicroUsd": 0,
            "monthlyLimitMicroUsd": 20_000_000, "monthlyLimitUsd": 20,
            "periodKey": "2026-10", "periodEnd": "2026-11-01T00:00:00.000Z",
            "monthlySpentMicroUsd": 20_000_000, "monthlySpentUsd": 20,
            "monthlyRemainingMicroUsd": 0, "monthlyRemainingUsd": 0,
            "walletType": "user"
        }
    }))
    .expect("parse");
    assert_eq!(wallet.balance_usd(), 0.0);
    assert_eq!(wallet.monthly_remaining(), Some(0.0));
    assert!(!wallet.can_spend());
}

fn studio_home(server: &MockServer, expires_at: i64) -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("tempdir");
    save_unieai_credentials(
        home.path(),
        &UnieAICredentials {
            account: UnieAIAccountKind::Studio,
            studio_url: server.uri(),
            access_token: "old-access".to_string(),
            refresh_token: "old-refresh".to_string(),
            expires_at,
            email: None,
            active_org_id: Some("org_1".to_string()),
            gateway_base_url: format!("{}/v1", server.uri()),
            gateway_api_key: "gw".to_string(),
            gateway_base_url_locked: false,
            available_model_ids: None,
            available_models: None,
        },
    )
    .expect("save");
    home
}

fn far_future() -> i64 {
    Utc::now().timestamp() + 3600
}

#[tokio::test]
async fn fetches_usage_with_the_device_token_and_org() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/usage/me"))
        .and(header("authorization", "Bearer old-access"))
        .and(header("x-org-id", "org_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(usage_body()))
        .expect(1)
        .mount(&server)
        .await;
    let home = studio_home(&server, far_future());
    let usage = fetch_unieai_usage(home.path())
        .await
        .expect("fetch")
        .expect("supported");
    assert_eq!(usage.plan.map(|plan| plan.key), Some("pro".to_string()));
}

#[tokio::test]
async fn a_404_means_the_studio_has_no_plan_usage_yet() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/usage/me"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let home = studio_home(&server, far_future());
    assert_eq!(fetch_unieai_usage(home.path()).await, Ok(None));
}

#[tokio::test]
async fn refreshes_an_expiring_token_first_and_retries_once_on_401() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/auth/device/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/wallet/me"))
        .and(header("authorization", "Bearer new-access"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "data": {"availableMicroUsd": 5_000_000, "monthlyLimitUsd": null, "monthlySpentUsd": 1}
        })))
        .mount(&server)
        .await;
    // Expired: refreshed before the call.
    let home = studio_home(&server, 0);
    let wallet = fetch_unieai_wallet(home.path())
        .await
        .expect("fetch")
        .expect("wallet");
    assert_eq!(wallet.balance_usd(), 5.0);
    assert_eq!(wallet.monthly_remaining(), None);
    let saved = load_unieai_credentials(home.path()).expect("saved");
    assert_eq!(saved.refresh_token, "new-refresh");
}

#[tokio::test]
async fn a_rejected_token_after_refresh_is_unauthorized() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/auth/device/token"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/usage/me"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;
    let home = studio_home(&server, far_future());
    assert_eq!(
        fetch_unieai_usage(home.path()).await,
        Err(StudioUsageError::Unauthorized)
    );
}

#[tokio::test]
async fn extra_usage_posts_the_choice_and_reads_back_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/usage/extra-usage"))
        .and(body_json(json!({"enabled": true})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": usage_body()})))
        .expect(1)
        .mount(&server)
        .await;
    let home = studio_home(&server, far_future());
    let usage = set_unieai_extra_usage(home.path(), true)
        .await
        .expect("toggle");
    assert!(usage.extra_usage.enabled);
}

#[tokio::test]
async fn studio_refusals_carry_its_message() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/usage/extra-usage"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "error": {"code": "forbidden", "message": "Only the group owner can change extra usage."}
        })))
        .mount(&server)
        .await;
    let home = studio_home(&server, far_future());
    assert_eq!(
        set_unieai_extra_usage(home.path(), true).await,
        Err(StudioUsageError::Rejected(
            "Only the group owner can change extra usage.".to_string()
        ))
    );
}

#[tokio::test]
async fn no_studio_login_is_not_signed_in() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        fetch_unieai_usage(home.path()).await,
        Err(StudioUsageError::NotSignedIn)
    );
}
