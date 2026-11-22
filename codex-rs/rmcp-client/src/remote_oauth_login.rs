//! Remote OAuth uses a short-lived Rabi rendezvous; PKCE and token exchange stay here.
//! The relay client is separate from the MCP transport and carries no account credentials.

use super::CallbackResult;
use super::OAuthHttpContext;
use super::OAuthLoginPurpose;
use super::OauthLoginFlow;
use super::callback_input::parse_callback_url;
use crate::McpOAuthClientRegistration;
use crate::StreamableHttpRedirectMode;
use crate::save_oauth_tokens;
use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use anyhow::bail;
use codex_config::McpServerOAuthConfig;
use codex_config::types::AuthKeyringBackendKind;
use codex_config::types::OAuthCredentialsStoreMode;
use codex_exec_server::HttpClient;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::timeout;
use url::Url;

const API_PATH: &str = "/api/mcp/oauth/remote";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
struct RemoteGrant {
    session_id: String,
    device_secret: String,
    redirect_uri: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct PollResponse {
    status: String,
    callback_url: Option<String>,
}

#[derive(Debug, thiserror::Error)]
enum RelayError {
    #[error("Remote OAuth service could not be reached")]
    Unavailable,
    #[error("Remote OAuth request timed out")]
    Timeout,
    #[error("Remote OAuth session expired; run login again")]
    Expired,
    #[error("Remote OAuth service rejected the request (HTTP {0})")]
    Status(u16),
    #[error("Remote OAuth service returned an invalid response")]
    InvalidResponse,
}

pub(crate) fn relay_origin(value: &str) -> Result<Url> {
    let origin = codex_http_client::validate_endpoint_url(value, "remote OAuth service")
        .map_err(anyhow::Error::msg)?;
    if origin.path() != "/" || origin.query().is_some() {
        bail!("Remote OAuth service must be an HTTPS origin without a path or query");
    }
    Ok(origin)
}

impl RemoteGrant {
    fn validate(&self, origin: &Url) -> Result<()> {
        let valid_identifier = |value: &str, min: usize, max: usize| {
            (min..=max).contains(&value.len())
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        };
        if !valid_identifier(&self.session_id, 16, 128)
            || !valid_identifier(&self.device_secret, 32, 256)
            || !(1..=600).contains(&self.expires_in)
            || !(1..=30).contains(&self.interval)
        {
            bail!("Remote OAuth service returned an invalid session");
        }
        // Exact URLs additionally prohibit cross-origin delivery, userinfo, query and fragments.
        let expected_redirect = origin.join(&format!("{API_PATH}/callback"))?;
        let expected_verification =
            origin.join(&format!("{API_PATH}/authorize/{}", self.session_id))?;
        if Url::parse(&self.redirect_uri).ok().as_ref() != Some(&expected_redirect)
            || Url::parse(&self.verification_uri).ok().as_ref() != Some(&expected_verification)
        {
            bail!("Remote OAuth service returned an unexpected callback or authorization URL");
        }
        Ok(())
    }

    fn credentials(&self) -> Value {
        json!({"session_id": self.session_id, "device_secret": self.device_secret})
    }
}

async fn post_json<T: DeserializeOwned>(
    client: &codex_http_client::HttpClient,
    origin: &Url,
    endpoint: &str,
    session_scoped: bool,
    body: Value,
) -> std::result::Result<T, RelayError> {
    let operation = async {
        let url = origin
            .join(&format!("{API_PATH}/{endpoint}"))
            .map_err(|_| RelayError::InvalidResponse)?;
        let mut response = client
            .post(url)
            .json(&body)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|_| RelayError::Unavailable)?;
        let status = response.status();
        if matches!(status.as_u16(), 404 | 410) {
            // A gone session endpoint means this login expired; a missing /start
            // means the relay has no remote OAuth at all, so "run login again"
            // would only loop.
            return Err(if session_scoped {
                RelayError::Expired
            } else {
                RelayError::Status(status.as_u16())
            });
        }
        if !status.is_success() {
            // Never display service-controlled bodies, redirect locations, or URLs.
            return Err(RelayError::Status(status.as_u16()));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| RelayError::Unavailable)?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(RelayError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            // Endpoints may acknowledge with 204 and no body: a `Value` target
            // accepts that as null, while a typed target still fails.
            return serde_json::from_value(Value::Null).map_err(|_| RelayError::InvalidResponse);
        }
        serde_json::from_slice(&bytes).map_err(|_| RelayError::InvalidResponse)
    };
    timeout(REQUEST_TIMEOUT, operation)
        .await
        .map_err(|_| RelayError::Timeout)?
}

async fn poll_callback(
    client: &codex_http_client::HttpClient,
    origin: &Url,
    grant: &RemoteGrant,
) -> Result<String> {
    let mut transient_failures = 0;
    loop {
        let response =
            post_json::<PollResponse>(client, origin, "poll", true, grant.credentials()).await;
        match response {
            Ok(response) if response.status == "callback" => {
                return response
                    .callback_url
                    .filter(|url| url.len() <= 64 * 1024)
                    .context("Remote OAuth service returned no usable callback");
            }
            Ok(response) if response.status == "pending" => transient_failures = 0,
            Ok(_) => bail!("Remote OAuth session is no longer pending; run login again"),
            Err(RelayError::Unavailable | RelayError::Timeout) if transient_failures < 2 => {
                // Delivery is repeatable for this secret until /complete acknowledges it.
                transient_failures += 1;
            }
            Err(error) => return Err(error.into()),
        }
        tokio::time::sleep(Duration::from_secs(grant.interval)).await;
    }
}

/// Authorize an MCP server through a public callback without starting a local HTTP listener.
/// `relay_client` must have no MCP/account headers, cookies, or automatic redirects.
#[allow(clippy::too_many_arguments)]
pub async fn perform_remote_oauth_login(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
    scopes: &[String],
    oauth_config: Option<&McpServerOAuthConfig>,
    client_registration: McpOAuthClientRegistration,
    oauth_resource: Option<&str>,
    http_client: Arc<dyn HttpClient>,
    relay_client: &codex_http_client::HttpClient,
    remote_url: &str,
    show_authorization: impl FnOnce(&str),
) -> Result<()> {
    perform_remote_oauth_login_with_cancel(
        server_name,
        server_url,
        store_mode,
        keyring_backend_kind,
        http_headers,
        env_http_headers,
        scopes,
        oauth_config,
        client_registration,
        oauth_resource,
        http_client,
        relay_client,
        remote_url,
        show_authorization,
        async {
            let _ = tokio::signal::ctrl_c().await;
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn perform_remote_oauth_login_with_cancel(
    server_name: &str,
    server_url: &str,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    http_headers: Option<HashMap<String, String>>,
    env_http_headers: Option<HashMap<String, String>>,
    scopes: &[String],
    oauth_config: Option<&McpServerOAuthConfig>,
    client_registration: McpOAuthClientRegistration,
    oauth_resource: Option<&str>,
    http_client: Arc<dyn HttpClient>,
    relay_client: &codex_http_client::HttpClient,
    remote_url: &str,
    show_authorization: impl FnOnce(&str),
    cancel: impl Future<Output = ()>,
) -> Result<()> {
    let origin = relay_origin(remote_url)?;
    if client_registration == McpOAuthClientRegistration::Cimd {
        bail!(
            "Remote MCP OAuth requires DCR or a client registered for the public callback; CIMD only supports loopback callbacks"
        );
    }
    let grant: RemoteGrant = post_json(relay_client, &origin, "start", false, json!({})).await?;
    grant.validate(&origin)?;
    let operation = async {
        let flow = OauthLoginFlow::new(
            server_name,
            server_url,
            store_mode,
            keyring_backend_kind,
            OAuthHttpContext {
                http_headers,
                env_http_headers,
                http_client,
                redirect_mode: StreamableHttpRedirectMode::Legacy,
            },
            scopes,
            oauth_config,
            OAuthLoginPurpose::Mcp,
            client_registration,
            oauth_resource,
            /*launch_browser*/ false,
            /*listen_for_callback*/ false,
            None,
            Some(&grant.redirect_uri),
            None,
            Some(grant.expires_in as i64),
        )
        .await?;
        if flow.redirect_uri != grant.redirect_uri {
            bail!("MCP authorization server does not support the public callback");
        }
        let authorization_url = flow.authorization_url();
        // Display identity needs no query parameters, which may contain MCP credentials.
        let mut display_server =
            Url::parse(server_url).map_err(|_| anyhow!("Invalid MCP server URL"))?;
        display_server.set_query(None);
        display_server.set_fragment(None);
        let _ = display_server.set_username("");
        let _ = display_server.set_password(None);
        let mut configure = grant.credentials();
        configure["authorization_url"] = json!(authorization_url);
        configure["server_url"] = json!(display_server.as_str());
        let _: Value = post_json(relay_client, &origin, "configure", true, configure).await?;
        show_authorization(&grant.verification_uri);
        let callback_url = poll_callback(relay_client, &origin, &grant).await?;
        let callback = parse_callback_url(&callback_url, &flow.redirect_uri, &authorization_url)?;
        if let CallbackResult::Success(callback) = &callback {
            let authorization = Url::parse(&authorization_url)?;
            if !authorization
                .query_pairs()
                .any(|(key, value)| key == "state" && value == callback.state)
            {
                bail!("OAuth callback state does not match this login");
            }
            if callback.issuer.as_deref() != flow.authorization_server_issuer.as_deref() {
                bail!("OAuth callback issuer does not match this login");
            }
        }
        let stored = flow.complete_callback(callback).await.map_err(|error| {
            if error.downcast_ref::<super::OAuthProviderError>().is_some() {
                error
            } else {
                anyhow!("OAuth token exchange failed; run login again")
            }
        })?;
        save_oauth_tokens(server_name, &stored, store_mode, keyring_backend_kind).await
    };
    let result = tokio::select! {
        result = timeout(Duration::from_secs(grant.expires_in), operation) => {
            result.unwrap_or_else(|_| Err(anyhow!("Remote OAuth session expired; run login again")))
        }
        () = cancel => Err(anyhow!("OAuth login cancelled")),
    };
    let mut completion = grant.credentials();
    completion["ok"] = json!(result.is_ok());
    // A repeatable acknowledgement closes the browser even if its first response was lost.
    let mut acknowledged = false;
    for attempt in 0..3 {
        match post_json::<Value>(relay_client, &origin, "complete", true, completion.clone()).await
        {
            Ok(_) => {
                acknowledged = true;
                break;
            }
            Err(RelayError::Unavailable | RelayError::Timeout) => {}
            Err(RelayError::Status(status)) if status >= 500 => {}
            Err(_) => break,
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
    if result.is_ok() && !acknowledged {
        eprintln!("Login succeeded, but the browser completion page could not be updated.");
    }

    result
}

#[cfg(test)]
#[path = "remote_oauth_login_tests.rs"]
mod tests;
