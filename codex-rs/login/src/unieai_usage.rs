// Copyright (c) 2026 UnieAI. All rights reserved.
//! UnieAI Studio plan usage and wallet.
//!
//! A Studio subscription draws each request from the plan's allowance first
//! (a 5-hour and a weekly window). When a window runs out, requests either
//! stop until it resets or, with the account's opt-in "extra usage", go on
//! against API credits (grants, then the wallet). This module reads that
//! state from Studio's `GET /api/usage/me`, flips extra usage with
//! `POST /api/usage/extra-usage`, and falls back to `GET /api/wallet/me` for a
//! Studio that predates plan usage. The contract is in
//! `docs/unieai/usage-api.md`.
//!
//! All three use the device-grant access token from `unieai.json`, refreshed
//! here when it is about to expire (or once more after Studio rejects it).

use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Deserializer;
use serde_json::Value;
use std::path::Path;

use crate::default_client::create_client;
use crate::unieai::UnieAIAccountKind;
use crate::unieai::UnieAICredentials;
use crate::unieai::ensure_fresh_studio_token;
use crate::unieai::load_unieai_credentials;

const MICRO_USD_PER_USD: f64 = 1_000_000.0;
pub const FIVE_HOUR_WINDOW_MINUTES: i64 = 5 * 60;
pub const WEEK_WINDOW_MINUTES: i64 = 7 * 24 * 60;

/// Why a Studio usage request did not produce data.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum StudioUsageError {
    #[error("Sign in with UnieAI Studio to see plan usage.")]
    NotSignedIn,
    #[error("Your UnieAI Studio sign-in has expired. Run `unieai login` to sign in again.")]
    Unauthorized,
    /// Studio refused the request and said why (403, 409, ...).
    #[error("{0}")]
    Rejected(String),
    #[error("UnieAI Studio answered HTTP {status}.")]
    Status { status: u16 },
    #[error("Couldn't reach UnieAI Studio: {0}")]
    Transport(String),
    #[error("Couldn't read UnieAI Studio's usage response: {0}")]
    Parse(String),
}

/// `GET /api/usage/me`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioUsage {
    #[serde(default)]
    pub plan: Option<StudioPlan>,
    #[serde(default)]
    pub windows: StudioUsageWindows,
    #[serde(default)]
    pub extra_usage: StudioExtraUsage,
    #[serde(default, deserialize_with = "null_as_default")]
    pub grants: Vec<StudioGrant>,
    #[serde(default)]
    pub wallet: Option<StudioWallet>,
    #[serde(default)]
    pub links: StudioUsageLinks,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct StudioPlan {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
}

impl StudioPlan {
    pub fn display_name(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.key
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioUsageWindows {
    #[serde(default)]
    pub five_hour: Option<StudioUsageWindow>,
    #[serde(default)]
    pub week: Option<StudioUsageWindow>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioUsageWindow {
    #[serde(default, deserialize_with = "lenient_i64")]
    pub used_micro_usd: Option<i64>,
    /// `None` is an unlimited window.
    #[serde(default, deserialize_with = "lenient_i64")]
    pub limit_micro_usd: Option<i64>,
    #[serde(default, deserialize_with = "lenient_datetime")]
    pub resets_at: Option<DateTime<Utc>>,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub window_minutes: Option<i64>,
}

impl StudioUsageWindow {
    /// Share of the allowance used, 0–100 (not capped: an overrun shows as
    /// more than 100). `None` for an unlimited window.
    pub fn used_percent(&self) -> Option<f64> {
        let limit = self.limit_micro_usd.filter(|limit| *limit > 0)?;
        let used = self.used_micro_usd.unwrap_or(0).max(0);
        Some(used as f64 * 100.0 / limit as f64)
    }

    pub fn is_exhausted(&self) -> bool {
        self.used_percent().is_some_and(|percent| percent >= 100.0)
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct StudioExtraUsage {
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioGrant {
    #[serde(default)]
    pub label: String,
    #[serde(default, deserialize_with = "lenient_i64")]
    pub remaining_micro_usd: Option<i64>,
    #[serde(default, deserialize_with = "lenient_datetime")]
    pub expires_at: Option<DateTime<Utc>>,
}

impl StudioGrant {
    pub fn remaining_usd(&self) -> f64 {
        self.remaining_micro_usd.unwrap_or(0) as f64 / MICRO_USD_PER_USD
    }
}

/// The wallet, in `/api/usage/me` and in `/api/wallet/me`'s `data`.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioWallet {
    #[serde(default, deserialize_with = "lenient_i64")]
    pub available_micro_usd: Option<i64>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub available_usd: Option<f64>,
    /// `None` is no monthly ceiling.
    #[serde(default, deserialize_with = "lenient_f64")]
    pub monthly_limit_usd: Option<f64>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub monthly_spent_usd: Option<f64>,
    #[serde(default, deserialize_with = "lenient_f64")]
    pub monthly_remaining_usd: Option<f64>,
    #[serde(default, deserialize_with = "lenient_datetime")]
    pub period_end: Option<DateTime<Utc>>,
}

impl StudioWallet {
    pub fn balance_usd(&self) -> f64 {
        self.available_micro_usd
            .map(|micro| micro as f64 / MICRO_USD_PER_USD)
            .or(self.available_usd)
            .unwrap_or(0.0)
    }

    /// What is left of the monthly ceiling; `None` when there is none.
    pub fn monthly_remaining(&self) -> Option<f64> {
        let limit = self.monthly_limit_usd?;
        Some(
            self.monthly_remaining_usd
                .unwrap_or_else(|| limit - self.monthly_spent_usd.unwrap_or(0.0))
                .max(0.0),
        )
    }

    /// Whether the wallet can pay for a request right now.
    pub fn can_spend(&self) -> bool {
        self.balance_usd() > 0.0 && self.monthly_remaining().is_none_or(|left| left > 0.0)
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StudioUsageLinks {
    #[serde(default)]
    pub manage: Option<String>,
    #[serde(default)]
    pub top_up: Option<String>,
}

impl StudioUsage {
    /// Whether usage past the plan allowance can go on against credits.
    pub fn credits_available(&self) -> bool {
        self.grants
            .iter()
            .any(|grant| grant.remaining_micro_usd.unwrap_or(0) > 0)
            || self.wallet.as_ref().is_some_and(StudioWallet::can_spend)
    }

    pub fn top_up_url(&self, studio_url: &str) -> String {
        self.links
            .top_up
            .clone()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| unieai_top_up_url(studio_url))
    }

    pub fn manage_url(&self, studio_url: &str) -> String {
        self.links
            .manage
            .clone()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| unieai_top_up_url(studio_url))
    }
}

/// Studio's plan and top-up page.
pub fn unieai_top_up_url(studio_url: &str) -> String {
    format!("{}/plan", studio_url.trim_end_matches('/'))
}

/// Parse a `/api/usage/me` (or extra-usage) body, bare or in Studio's
/// `{request_id, data}` envelope.
pub fn parse_studio_usage(body: Value) -> Result<StudioUsage, StudioUsageError> {
    serde_json::from_value(unwrap_envelope(body))
        .map_err(|err| StudioUsageError::Parse(err.to_string()))
}

/// Parse a `/api/wallet/me` body.
pub fn parse_studio_wallet(body: Value) -> Result<StudioWallet, StudioUsageError> {
    serde_json::from_value(unwrap_envelope(body))
        .map_err(|err| StudioUsageError::Parse(err.to_string()))
}

fn unwrap_envelope(body: Value) -> Value {
    match body {
        Value::Object(mut map)
            if map.get("data").is_some_and(Value::is_object)
                && !["plan", "windows", "wallet", "availableMicroUsd"]
                    .iter()
                    .any(|key| map.contains_key(*key)) =>
        {
            map.remove("data").unwrap_or_default()
        }
        other => other,
    }
}

/// Plan usage for the signed-in Studio account. `Ok(None)` when this Studio
/// does not serve `/api/usage/me` yet (404): not an error.
pub async fn fetch_unieai_usage(
    codex_home: &Path,
) -> Result<Option<StudioUsage>, StudioUsageError> {
    studio_request(codex_home, http::Method::GET, "/api/usage/me", None)
        .await?
        .map(parse_studio_usage)
        .transpose()
}

/// The wallet alone, for a Studio without plan usage. `Ok(None)` on 404.
pub async fn fetch_unieai_wallet(
    codex_home: &Path,
) -> Result<Option<StudioWallet>, StudioUsageError> {
    studio_request(codex_home, http::Method::GET, "/api/wallet/me", None)
        .await?
        .map(parse_studio_wallet)
        .transpose()
}

/// Turn extra usage (billing API credits past the plan allowance) on or off.
pub async fn set_unieai_extra_usage(
    codex_home: &Path,
    enabled: bool,
) -> Result<StudioUsage, StudioUsageError> {
    let body = serde_json::json!({ "enabled": enabled });
    match studio_request(
        codex_home,
        http::Method::POST,
        "/api/usage/extra-usage",
        Some(body),
    )
    .await?
    {
        Some(body) => parse_studio_usage(body),
        None => Err(StudioUsageError::Status { status: 404 }),
    }
}

/// The signed-in Studio login, or why there is none.
fn studio_credentials(codex_home: &Path) -> Result<UnieAICredentials, StudioUsageError> {
    match load_unieai_credentials(codex_home) {
        Some(credentials) if credentials.account == UnieAIAccountKind::Studio => Ok(credentials),
        _ => Err(StudioUsageError::NotSignedIn),
    }
}

/// One authenticated Studio call. `Ok(None)` for 404; a 401 refreshes the
/// token and tries once more.
async fn studio_request(
    codex_home: &Path,
    method: http::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>, StudioUsageError> {
    let mut credentials = studio_credentials(codex_home)?;
    let client = create_client();
    ensure_fresh_studio_token(&client, codex_home, &mut credentials, /*force*/ false)
        .await
        .map_err(|_| StudioUsageError::Unauthorized)?;
    let url = format!("{}{path}", credentials.studio_url.trim_end_matches('/'));
    for attempt in 0..2 {
        let mut request = client
            .request(method.clone(), &url)
            .header("Accept", "application/json")
            .header(
                "Authorization",
                format!("Bearer {}", credentials.access_token),
            );
        if let Some(org) = credentials.active_org_id.as_deref() {
            request = request.header("x-org-id", org);
        }
        if let Some(body) = &body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|err| StudioUsageError::Transport(err.to_string()))?;
        let status = response.status();
        if status == http::StatusCode::UNAUTHORIZED {
            if attempt == 0
                && ensure_fresh_studio_token(&client, codex_home, &mut credentials, true)
                    .await
                    .is_ok()
            {
                continue;
            }
            return Err(StudioUsageError::Unauthorized);
        }
        if status == http::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let text = response
            .text()
            .await
            .map_err(|err| StudioUsageError::Transport(err.to_string()))?;
        if !status.is_success() {
            let message = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|message| !message.is_empty())
                    .map(str::to_string)
            });
            return Err(match message {
                Some(message) if status.is_client_error() => StudioUsageError::Rejected(message),
                _ => StudioUsageError::Status {
                    status: status.as_u16(),
                },
            });
        }
        return serde_json::from_str(&text)
            .map(Some)
            .map_err(|err| StudioUsageError::Parse(err.to_string()));
    }
    Err(StudioUsageError::Unauthorized)
}

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A number Studio may send as a JSON number or a numeric string; anything
/// else reads as absent rather than failing the whole response.
fn lenient_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    })
}

fn lenient_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.round() as i64)),
        Value::String(text) => text
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| text.trim().parse::<f64>().ok().map(|v| v.round() as i64)),
        _ => None,
    })
}

fn lenient_datetime<'de, D>(deserializer: D) -> Result<Option<DateTime<Utc>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|time| time.with_timezone(&Utc)),
        // Unix seconds, as the rate-limit headers carry them.
        Value::Number(number) => number
            .as_i64()
            .and_then(|seconds| DateTime::from_timestamp(seconds, 0)),
        _ => None,
    })
}

#[cfg(test)]
#[path = "unieai_usage_tests.rs"]
mod tests;
