//! UnieAI Studio device-code login.
//!
//! Signs the user into UnieAI Studio with the OAuth device-code grant, then
//! resolves the inference gateway credentials (base URL + runtime API key)
//! from Studio's `/api/config` and persists everything to
//! `$CODEX_HOME/unieai.json`. Inference requests never touch the OAuth
//! tokens: the gateway runtime key is the bearer used by the `unieai` model
//! provider, so token refresh is only ever needed for Studio API calls.

use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use crate::default_client::create_client;

/// Client id registered with UnieAI Studio's device-auth endpoints. Studio
/// only recognizes this id (it predates the codex-based CLI), so it is kept
/// even though the product is no longer OpenCode-based.
pub const UNIEAI_CLIENT_ID: &str = "opencode-cli";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub const DEFAULT_STUDIO_URL: &str = "https://studio.unieai.com";
pub const DEFAULT_GATEWAY_BASE_URL: &str = "https://api.unieai.com/v1";

const UNIEAI_CREDENTIALS_FILE: &str = "unieai.json";

/// Persisted result of a UnieAI Studio login.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnieAICredentials {
    pub studio_url: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix timestamp (seconds) when `access_token` expires.
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_org_id: Option<String>,
    pub gateway_base_url: String,
    pub gateway_api_key: String,
    /// Set when the user supplied an explicit gateway URL at login; a later
    /// model sync must not overwrite it with a Studio-derived URL.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gateway_base_url_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_model_ids: Option<Vec<String>>,
}

pub fn unieai_credentials_path(codex_home: &Path) -> PathBuf {
    codex_home.join(UNIEAI_CREDENTIALS_FILE)
}

/// Loads stored UnieAI credentials, returning `None` when absent or invalid.
pub fn load_unieai_credentials(codex_home: &Path) -> Option<UnieAICredentials> {
    let contents = std::fs::read_to_string(unieai_credentials_path(codex_home)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn save_unieai_credentials(
    codex_home: &Path,
    credentials: &UnieAICredentials,
) -> io::Result<()> {
    std::fs::create_dir_all(codex_home)?;
    let path = unieai_credentials_path(codex_home);
    let json = serde_json::to_string_pretty(credentials).map_err(io::Error::other)?;

    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path)?;
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}

pub fn delete_unieai_credentials(codex_home: &Path) -> io::Result<bool> {
    match std::fs::remove_file(unieai_credentials_path(codex_home)) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// Normalizes a user/env supplied URL: prepends `https://` when scheme-less
/// and strips trailing slashes. Any path (e.g. `/v1`) is preserved as given.
pub fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn resolve_studio_url(override_url: Option<&str>) -> String {
    let candidate = override_url
        .map(str::to_string)
        .or_else(|| {
            std::env::var("UNIEAI_STUDIO_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| DEFAULT_STUDIO_URL.to_string());
    normalize_url(&candidate)
}

/// Derives an inference gateway from the Studio host by swapping the leading
/// `studio.` label for `api.` (studio.unieai.com -> api.unieai.com, including
/// on-prem hosts like studio.demo.unieai.com). Falls back to the public cloud
/// gateway when the Studio URL cannot be parsed.
fn derive_gateway_from_studio(studio_url: &str) -> String {
    let Ok(url) = url::Url::parse(&normalize_url(studio_url)) else {
        return DEFAULT_GATEWAY_BASE_URL.to_string();
    };
    let Some(host) = url.host_str() else {
        return DEFAULT_GATEWAY_BASE_URL.to_string();
    };
    let host = match host.strip_prefix("studio.") {
        Some(rest) => format!("api.{rest}"),
        None => host.to_string(),
    };
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}/v1", url.scheme())
}

/// Gateway base URL precedence, mirroring the original CLI so on-prem
/// deployments never silently fall back to the public cloud gateway:
/// `UNIEAI_GATEWAY_URL` env, then the URL the user typed at login, then a
/// publicly reachable base URL from Studio `/api/config`, then one derived
/// from the Studio host.
fn resolve_gateway_base_url(
    studio_url: &str,
    user_gateway_url: Option<&str>,
    config_base_url: Option<&str>,
) -> String {
    if let Ok(env) = std::env::var("UNIEAI_GATEWAY_URL")
        && !env.trim().is_empty()
    {
        return normalize_url(&env);
    }

    if let Some(user) = user_gateway_url
        && !user.trim().is_empty()
    {
        return normalize_url(user);
    }

    if let Some(config) = config_base_url
        && is_publicly_reachable(config)
    {
        return normalize_url(config);
    }

    derive_gateway_from_studio(studio_url)
}

/// Studio configs may carry cluster-internal base URLs (runtime:, localhost,
/// 127.*) that are not reachable from the user's machine.
fn is_publicly_reachable(base_url: &str) -> bool {
    let lower = base_url.trim().to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && !["http://runtime:", "https://runtime:"]
            .iter()
            .any(|p| lower.starts_with(p))
        && !lower.starts_with("http://localhost")
        && !lower.starts_with("https://localhost")
        && !lower.starts_with("http://127.")
        && !lower.starts_with("https://127.")
}

#[derive(Debug, Deserialize)]
struct DeviceAuthResponse {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct TokenErrorResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StudioUser {
    email: String,
}

#[derive(Debug, Deserialize)]
struct StudioOrg {
    id: String,
}

#[derive(Debug, Default, Deserialize)]
struct StudioRemoteConfig {
    #[serde(default)]
    provider: HashMap<String, serde_json::Value>,
}

/// Newer Studio builds nest the gateway credentials under `options`; older
/// ones put them at the top level. Both shapes are accepted, matching the
/// original TS client.
#[derive(Debug, Default, Deserialize)]
struct StudioProviderOptions {
    #[serde(rename = "baseURL")]
    base_url: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StudioProviderConfig {
    #[serde(default)]
    options: Option<StudioProviderOptions>,
    #[serde(rename = "baseURL")]
    base_url: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    #[serde(default)]
    models: HashMap<String, serde_json::Value>,
}

impl StudioProviderConfig {
    fn api_key(&self) -> Option<&str> {
        self.options
            .as_ref()
            .and_then(|options| options.api_key.as_deref())
            .or(self.api_key.as_deref())
    }

    fn base_url(&self) -> Option<&str> {
        self.options
            .as_ref()
            .and_then(|options| options.base_url.as_deref())
            .or(self.base_url.as_deref())
    }
}

/// Progress callback so the CLI (and later the TUI) can render the user code
/// prompt without this module owning the presentation.
pub struct UnieAIDevicePrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub studio_url: String,
}

pub struct UnieAILoginOptions {
    pub studio_url: Option<String>,
    /// Explicit inference gateway URL typed by the user (on-prem installs).
    pub gateway_url: Option<String>,
    pub on_prompt: Box<dyn Fn(&UnieAIDevicePrompt) + Send + Sync>,
}

/// Runs the full UnieAI Studio device login and persists the credentials.
pub async fn run_unieai_device_login(
    codex_home: &Path,
    options: UnieAILoginOptions,
) -> io::Result<UnieAICredentials> {
    let studio_url = resolve_studio_url(options.studio_url.as_deref());
    let client = create_client();

    // 1. Request a device code.
    let device: DeviceAuthResponse = post_json(
        &client,
        &format!("{studio_url}/auth/device/code"),
        &serde_json::json!({ "client_id": UNIEAI_CLIENT_ID }),
        None,
        "device code request",
    )
    .await?;

    let verification_uri = if device.verification_uri_complete.starts_with("http") {
        device.verification_uri_complete.clone()
    } else {
        format!(
            "{studio_url}/{}",
            device.verification_uri_complete.trim_start_matches('/')
        )
    };
    (options.on_prompt)(&UnieAIDevicePrompt {
        user_code: device.user_code.clone(),
        verification_uri,
        studio_url: studio_url.clone(),
    });

    // 2. Poll for tokens.
    let tokens = poll_for_tokens(&client, &studio_url, &device).await?;

    // 3. Resolve gateway credentials from Studio config (best-effort org).
    let email = get_json::<StudioUser>(
        &client,
        &format!("{studio_url}/api/user"),
        &tokens.access_token,
        None,
    )
    .await
    .ok()
    .map(|user| user.email);

    let active_org_id = get_json::<Vec<StudioOrg>>(
        &client,
        &format!("{studio_url}/api/orgs"),
        &tokens.access_token,
        None,
    )
    .await
    .ok()
    .and_then(|orgs| orgs.into_iter().next())
    .map(|org| org.id);

    let provider_config = fetch_unieai_provider_config(
        &client,
        &studio_url,
        &tokens.access_token,
        active_org_id.as_deref(),
    )
    .await;

    let gateway_api_key = provider_config
        .as_ref()
        .and_then(|config| config.api_key().map(str::to_string))
        .ok_or_else(|| {
            io::Error::other(
                "UnieAI Studio did not return a gateway API key; check that your account has \
inference access (Studio → Keys), then retry `unieai login`",
            )
        })?;

    let gateway_base_url = resolve_gateway_base_url(
        &studio_url,
        options.gateway_url.as_deref(),
        provider_config
            .as_ref()
            .and_then(|config| config.base_url()),
    );

    let available_model_ids = provider_config
        .as_ref()
        .filter(|config| !config.models.is_empty())
        .map(|config| {
            let mut ids: Vec<String> = config.models.keys().cloned().collect();
            ids.sort();
            ids
        });

    let credentials = UnieAICredentials {
        studio_url,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: chrono::Utc::now().timestamp() + tokens.expires_in,
        email,
        active_org_id,
        gateway_base_url,
        gateway_api_key,
        gateway_base_url_locked: options.gateway_url.is_some(),
        available_model_ids,
    };
    save_unieai_credentials(codex_home, &credentials)?;
    Ok(credentials)
}

async fn poll_for_tokens(
    client: &codex_http_client::HttpClient,
    studio_url: &str,
    device: &DeviceAuthResponse,
) -> io::Result<TokenResponse> {
    let url = format!("{studio_url}/auth/device/token");
    let max_wait = Duration::from_secs(device.expires_in.max(60));
    let start = Instant::now();
    let mut interval = Duration::from_secs(device.interval.unwrap_or(5).max(1));

    loop {
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(
                serde_json::json!({
                    "grant_type": DEVICE_GRANT_TYPE,
                    "device_code": device.device_code,
                    "client_id": UNIEAI_CLIENT_ID,
                })
                .to_string(),
            )
            .send()
            .await
            .map_err(io::Error::other)?;

        if resp.status().is_success() {
            return resp.json().await.map_err(io::Error::other);
        }

        let error: TokenErrorResponse = resp.json().await.unwrap_or(TokenErrorResponse {
            error: None,
            error_description: None,
        });
        match error.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += Duration::from_secs(5),
            Some("expired_token") => {
                return Err(io::Error::other("device code expired; run login again"));
            }
            Some("access_denied") => {
                return Err(io::Error::other("login was denied in UnieAI Studio"));
            }
            other => {
                let detail = error
                    .error_description
                    .or_else(|| other.map(str::to_string))
                    .unwrap_or_else(|| "unknown error".to_string());
                return Err(io::Error::other(format!("device token request failed: {detail}")));
            }
        }

        if start.elapsed() >= max_wait {
            return Err(io::Error::other("device login timed out; run login again"));
        }
        tokio::time::sleep(interval.min(max_wait - start.elapsed())).await;
    }
}

async fn fetch_unieai_provider_config(
    client: &codex_http_client::HttpClient,
    studio_url: &str,
    access_token: &str,
    org_id: Option<&str>,
) -> Option<StudioProviderConfig> {
    #[derive(Deserialize)]
    struct ConfigEnvelope {
        #[serde(default)]
        config: Option<StudioRemoteConfig>,
    }

    let envelope: ConfigEnvelope = get_json(
        client,
        &format!("{studio_url}/api/config"),
        access_token,
        org_id,
    )
    .await
    .ok()?;
    let unieai = envelope.config?.provider.remove("unieai")?;
    serde_json::from_value(unieai).ok()
}

/// Revokes the refresh token with Studio (best-effort) and removes the stored
/// credentials. Returns `false` when there was nothing to log out of.
pub async fn logout_unieai(codex_home: &Path) -> io::Result<bool> {
    let Some(credentials) = load_unieai_credentials(codex_home) else {
        return Ok(false);
    };

    let client = create_client();
    let revoke = client
        .post(format!("{}/auth/device/revoke", credentials.studio_url))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(
            serde_json::json!({
                "refresh_token": credentials.refresh_token,
                "client_id": UNIEAI_CLIENT_ID,
            })
            .to_string(),
        )
        .send()
        .await;
    if let Err(err) = revoke {
        tracing::warn!("failed to revoke UnieAI refresh token: {err}");
    }

    delete_unieai_credentials(codex_home)
}

async fn post_json<T: serde::de::DeserializeOwned>(
    client: &codex_http_client::HttpClient,
    url: &str,
    body: &serde_json::Value,
    bearer: Option<&str>,
    label: &str,
) -> io::Result<T> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .body(body.to_string());
    if let Some(token) = bearer {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    let resp = request.send().await.map_err(io::Error::other)?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(io::Error::other(format!(
            "{label} failed: HTTP {status}{}",
            if body.is_empty() {
                String::new()
            } else {
                format!(" — {}", &body[..body.len().min(300)])
            }
        )));
    }
    resp.json().await.map_err(io::Error::other)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    client: &codex_http_client::HttpClient,
    url: &str,
    bearer: &str,
    org_id: Option<&str>,
) -> io::Result<T> {
    let mut request = client
        .get(url)
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {bearer}"));
    if let Some(org) = org_id {
        request = request.header("x-org-id", org);
    }
    let resp = request.send().await.map_err(io::Error::other)?;
    if !resp.status().is_success() {
        return Err(io::Error::other(format!(
            "GET {url} failed: HTTP {}",
            resp.status()
        )));
    }
    resp.json().await.map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn normalizes_scheme_less_urls() {
        assert_eq!(
            normalize_url("studio.demo.unieai.com/"),
            "https://studio.demo.unieai.com"
        );
        assert_eq!(normalize_url("https://a.b/v1//"), "https://a.b/v1");
    }

    #[test]
    fn derives_gateway_from_studio_host() {
        assert_eq!(
            derive_gateway_from_studio("https://studio.unieai.com"),
            "https://api.unieai.com/v1"
        );
        assert_eq!(
            derive_gateway_from_studio("https://studio.demo.unieai.com"),
            "https://api.demo.unieai.com/v1"
        );
        assert_eq!(
            derive_gateway_from_studio("https://gateway.corp.example:8443"),
            "https://gateway.corp.example:8443/v1"
        );
    }

    #[test]
    fn rejects_internal_config_base_urls() {
        assert!(!is_publicly_reachable("http://runtime:8080/v1"));
        assert!(!is_publicly_reachable("http://localhost:4000/v1"));
        assert!(!is_publicly_reachable("http://127.0.0.1/v1"));
        assert!(is_publicly_reachable("https://api.demo.unieai.com/v1"));
    }

    #[test]
    fn gateway_precedence_prefers_user_url_over_config() {
        let resolved = resolve_gateway_base_url(
            "https://studio.demo.unieai.com",
            Some("gw.demo.unieai.com/v1"),
            Some("https://api.demo.unieai.com/v1"),
        );
        assert_eq!(resolved, "https://gw.demo.unieai.com/v1");
    }

    #[test]
    fn credentials_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let credentials = UnieAICredentials {
            studio_url: "https://studio.unieai.com".to_string(),
            access_token: "at".to_string(),
            refresh_token: "rt".to_string(),
            expires_at: 123,
            email: Some("user@example.com".to_string()),
            active_org_id: None,
            gateway_base_url: "https://api.unieai.com/v1".to_string(),
            gateway_api_key: "sk-unieai".to_string(),
            gateway_base_url_locked: false,
            available_model_ids: Some(vec!["m1".to_string()]),
        };
        save_unieai_credentials(dir.path(), &credentials).expect("save");
        assert_eq!(load_unieai_credentials(dir.path()), Some(credentials));
    }
}
