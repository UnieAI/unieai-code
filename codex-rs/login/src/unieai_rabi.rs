// Copyright (c) 2026 UnieAI. All rights reserved.
//! UnieAI Rabi device-code login.
//!
//! Rabi (the UnieAI agent web product, `agent.unieai.com`) signs a desktop in
//! with its own device grant: `POST /api/desktop/device/start` returns a user
//! code, the person approves it at `/desktop/authorize`, and
//! `POST /api/desktop/device/poll` then answers with a long-lived desktop API
//! key. That key authenticates the product's chat-completions relay at
//! `/api/desktop/v1` and its entitled-model list at `/api/desktop/models`.
//!
//! The login is stored in the same `unieai.json` as a Studio login, with
//! `account: "rabi"`, so every consumer that reads the gateway fields works
//! unchanged. The relay has no Responses API, so a Rabi account runs on the
//! uac engine only.

use serde::Deserialize;
use std::io;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;

use crate::default_client::create_client;
use crate::unieai::UnieAIAccountKind;
use crate::unieai::UnieAICredentials;
use crate::unieai::UnieAIModel;
use crate::unieai::get_json;
use crate::unieai::normalize_url;
use crate::unieai::post_json;
use crate::unieai::save_unieai_credentials;

pub const DEFAULT_RABI_URL: &str = "https://agent.unieai.com";

/// Where the product's approval page lives (it completes the grant itself).
const APPROVE_PATH: &str = "/desktop/authorize";
const RELAY_PATH: &str = "/api/desktop/v1";
/// Stands in for token expiry: a desktop key does not expire client-side.
const NO_EXPIRY: i64 = i64::MAX;
/// Who is enrolling. Rabi names the minted key after this and retires only
/// this user's previous keys *of the same name*, so declaring one keeps our
/// login and the desktop app's from evicting each other. A name unset means
/// "UnieAI Agent Desktop", which is the desktop app's seat, not ours. The
/// string is shown to the person on the approval page, so it reads as a
/// product name rather than a package name.
const CLIENT_NAME: &str = "UnieAI Code";

pub struct UnieAIRabiPrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub rabi_url: String,
}

pub struct UnieAIRabiLoginOptions {
    /// Rabi origin for other deployments (default: [`DEFAULT_RABI_URL`]).
    pub rabi_url: Option<String>,
    pub on_prompt: Box<dyn Fn(&UnieAIRabiPrompt) + Send + Sync>,
}

#[derive(Debug, Deserialize)]
struct DeviceStart {
    #[serde(default)]
    device_code: String,
    #[serde(default)]
    user_code: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct RabiUser {
    #[serde(default)]
    id: String,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePoll {
    #[serde(default)]
    status: String,
    #[serde(default)]
    retry_after_seconds: Option<u64>,
    #[serde(default, rename = "api_key")]
    api_key: Option<String>,
    #[serde(default)]
    user: Option<RabiUser>,
    #[serde(default)]
    error: Option<String>,
}

/// One entitled model as `/api/desktop/models` reports it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitledModel {
    #[serde(default)]
    value: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    accepts_images: bool,
    /// `custom_model` for a UnieAI Studio custom model, `base_model`
    /// otherwise. A custom model is an agent of its own, with its own tools
    /// and harness; running one inside this agent stacks two agents on one
    /// turn, so they are left out of the menu.
    #[serde(default)]
    model_type: String,
}

/// What [`EntitledModel::model_type`] calls a Studio custom model.
const CUSTOM_MODEL: &str = "custom_model";

#[derive(Debug, Deserialize)]
struct EntitledModels {
    #[serde(default)]
    models: Vec<EntitledModel>,
}

pub fn resolve_rabi_url(override_url: Option<&str>) -> String {
    override_url
        .map(str::to_string)
        .or_else(|| std::env::var("UNIEAI_RABI_URL").ok())
        .filter(|url| !url.trim().is_empty())
        .map(|url| normalize_url(&url))
        .unwrap_or_else(|| DEFAULT_RABI_URL.to_string())
}

/// The relay a Rabi account's model requests go to.
pub fn rabi_gateway_url(rabi_url: &str) -> String {
    format!("{}{RELAY_PATH}", rabi_url.trim_end_matches('/'))
}

/// Entitled models in the product's order, de-duplicated, as stored models.
fn models_from_entitlements(models: Vec<EntitledModel>) -> Vec<UnieAIModel> {
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .filter(|model| model.model_type != CUSTOM_MODEL)
        .filter(|model| !model.value.is_empty() && seen.insert(model.value.clone()))
        .map(|model| UnieAIModel {
            name: (!model.label.is_empty() && model.label != model.value).then_some(model.label),
            input_modalities: Some(if model.accepts_images {
                vec!["text".to_string(), "image".to_string()]
            } else {
                vec!["text".to_string()]
            }),
            id: model.value,
            context_window: None,
        })
        .collect()
}

async fn fetch_entitled_models(
    client: &codex_http_client::HttpClient,
    rabi_url: &str,
    api_key: &str,
) -> io::Result<Vec<UnieAIModel>> {
    let list: EntitledModels = get_json(
        client,
        &format!("{rabi_url}/api/desktop/models"),
        api_key,
        None,
    )
    .await?;
    Ok(models_from_entitlements(list.models))
}

/// Runs the Rabi device login and persists the credentials.
pub async fn run_rabi_device_login(
    codex_home: &Path,
    options: UnieAIRabiLoginOptions,
) -> io::Result<UnieAICredentials> {
    let rabi_url = resolve_rabi_url(options.rabi_url.as_deref());
    let client = create_client();

    let grant: DeviceStart = post_json(
        &client,
        &format!("{rabi_url}/api/desktop/device/start"),
        &serde_json::json!({ "client_name": CLIENT_NAME }),
        None,
        "Rabi device login start",
    )
    .await?;
    if grant.device_code.is_empty() || grant.user_code.is_empty() {
        return Err(io::Error::other(
            "UnieAI Rabi did not return a device code; try again later",
        ));
    }
    let verification_uri = format!(
        "{rabi_url}{APPROVE_PATH}?code={}",
        urlencoding_component(&grant.user_code)
    );
    (options.on_prompt)(&UnieAIRabiPrompt {
        user_code: grant.user_code.clone(),
        verification_uri,
        rabi_url: rabi_url.clone(),
    });

    let (api_key, user) = poll_for_key(&client, &rabi_url, &grant).await?;
    let models = match fetch_entitled_models(&client, &rabi_url, &api_key).await {
        Ok(models) => Some(models),
        Err(err) => {
            tracing::warn!(%err, "could not read Rabi models at login");
            None
        }
    };
    let credentials = UnieAICredentials {
        account: UnieAIAccountKind::Rabi,
        studio_url: rabi_url.clone(),
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: NO_EXPIRY,
        email: user.email.filter(|email| !email.is_empty()),
        active_org_id: None,
        gateway_base_url: rabi_gateway_url(&rabi_url),
        gateway_api_key: api_key,
        gateway_base_url_locked: true,
        available_model_ids: None,
        available_models: models,
    };
    save_unieai_credentials(codex_home, &credentials)?;
    Ok(credentials)
}

async fn poll_for_key(
    client: &codex_http_client::HttpClient,
    rabi_url: &str,
    grant: &DeviceStart,
) -> io::Result<(String, RabiUser)> {
    let url = format!("{rabi_url}/api/desktop/device/poll");
    let max_wait = Duration::from_secs(grant.expires_in.unwrap_or(600).max(60));
    let interval = Duration::from_secs(grant.interval.unwrap_or(3).max(1));
    let start = Instant::now();
    loop {
        let poll: DevicePoll = post_json(
            client,
            &url,
            // Also here: the grant carries the name from `start`, but a
            // deployment old enough not to record it falls back to the body.
            &serde_json::json!({
                "device_code": grant.device_code,
                "client_name": CLIENT_NAME,
            }),
            None,
            "Rabi device login poll",
        )
        .await?;
        let wait = match poll.status.as_str() {
            "pending" => poll
                .retry_after_seconds
                .map(Duration::from_secs)
                .unwrap_or(interval)
                .max(interval),
            "approved" => {
                let user = poll.user.unwrap_or_default();
                return match poll.api_key.filter(|key| !key.is_empty()) {
                    Some(key) if !user.id.is_empty() => Ok((key, user)),
                    _ => Err(io::Error::other(
                        "UnieAI Rabi approved the login but returned no usable key",
                    )),
                };
            }
            "expired" => return Err(io::Error::other("device code expired; run login again")),
            "denied" => return Err(io::Error::other("login was denied in UnieAI Rabi")),
            other => {
                let detail = poll
                    .error
                    .unwrap_or_else(|| format!("unexpected status \"{other}\""));
                return Err(io::Error::other(format!(
                    "Rabi device login failed: {detail}"
                )));
            }
        };
        if start.elapsed() + wait >= max_wait {
            return Err(io::Error::other("device login timed out; run login again"));
        }
        tokio::time::sleep(wait).await;
    }
}

/// Refresh a Rabi account's entitled models (the key itself does not rotate).
pub(crate) async fn sync_rabi_account(
    codex_home: &Path,
    mut credentials: UnieAICredentials,
) -> io::Result<UnieAICredentials> {
    let client = create_client();
    let models = fetch_entitled_models(
        &client,
        credentials.studio_url.trim_end_matches('/'),
        &credentials.gateway_api_key,
    )
    .await?;
    credentials.available_models = Some(models);
    credentials.available_model_ids = None;
    save_unieai_credentials(codex_home, &credentials)?;
    Ok(credentials)
}

/// Percent-encodes a user code for a query string (codes are `A-Z0-9-`, so
/// only the unexpected is escaped).
fn urlencoding_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
#[path = "unieai_rabi_tests.rs"]
mod tests;
