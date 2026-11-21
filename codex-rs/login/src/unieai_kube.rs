// Copyright (c) 2026 UnieAI. All rights reserved.
//! vCluster credentials from UnieAI Studio for `kubectl` (`unieai kube`).
//!
//! Studio issues each person a 15-minute Kubernetes token for a vCluster they
//! have access to (`POST /api/on-prem/clusters/{id}/access/token`, answered as a
//! `client.authentication.k8s.io/v1` ExecCredential). `unieai kube token` is the
//! kubectl exec credential plugin: it reuses the Studio device login from
//! `unieai login` (the same access token `/usage` uses), caches each token under
//! `$CODEX_HOME/unieai-kube/` (0600) until shortly before it expires, and prints
//! the ExecCredential on stdout. `unieai kube kubeconfig` fetches a kubeconfig
//! whose user runs that plugin (`GET .../access/kubeconfig`): the file holds no
//! secret, and private-network vClusters already point at the platform relay.
//!
//! CI and other automation use a project machine identity instead: with
//! `UNIEAI_MACHINE_KEY` set to its exchange key, `kube token` sends that key and
//! needs `--studio` (no sign-in is read).
//!
//! Revocation follows Studio: removing someone's access stops new tokens at
//! once, and a cached token lives at most 15 minutes.

use chrono::DateTime;
use chrono::Utc;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use crate::default_client::create_client;
use crate::unieai::UnieAIAccountKind;
use crate::unieai::UnieAICredentials;
use crate::unieai::ensure_fresh_studio_token;
use crate::unieai::load_unieai_credentials;
use crate::unieai::normalize_url;

const CACHE_DIR: &str = "unieai-kube";
/// A cached token is reused while it has more than this left.
const CACHE_MARGIN_SECS: i64 = 60;
/// Studio answers 409 while a new assignment is still being applied to the
/// vCluster; the plugin waits and asks again this many times.
const PENDING_ATTEMPTS: u32 = 6;
const PENDING_DELAY: Duration = Duration::from_secs(5);
/// A project machine identity's exchange key, for CI. Not `UNIEAI_API_KEY`:
/// that is the model gateway key, which many people export for other reasons.
pub const MACHINE_KEY_ENV: &str = "UNIEAI_MACHINE_KEY";

/// Why `unieai kube` could not produce a credential.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum KubeError {
    #[error("Not signed in to UnieAI Studio. Run `unieai login` (Studio), then try again.")]
    NotSignedIn,
    #[error(
        "This kubeconfig belongs to {wanted}, but you are signed in to {signed_in}. Run `unieai login --studio {wanted}`."
    )]
    OtherStudio { wanted: String, signed_in: String },
    #[error("Your UnieAI Studio sign-in has expired. Run `unieai login` to sign in again.")]
    Unauthorized,
    #[error(
        "UnieAI Studio did not accept the machine identity key in UNIEAI_MACHINE_KEY (disabled, revoked or mistyped)."
    )]
    MachineKeyRejected,
    #[error("UNIEAI_MACHINE_KEY is set, so pass the Studio URL with --studio.")]
    MachineKeyNeedsStudio,
    #[error("{0}")]
    NoAccess(String),
    #[error(
        "vCluster {0} was not found: it may have been removed, or you are not a member of its project."
    )]
    NotFound(String),
    #[error(
        "This vCluster is on a private network and the platform's connection relay is not enabled. Use the web terminal in UnieAI Studio, or ask the platform administrator to enable the relay."
    )]
    RelayDisabled,
    #[error("Your access to this vCluster is still being applied. Try again in a minute.")]
    Pending,
    #[error("Too many token requests. Wait a moment and try again.")]
    RateLimited,
    #[error("{0}")]
    Rejected(String),
    #[error("UnieAI Studio answered HTTP {0}.")]
    Status(u16),
    #[error("Couldn't reach UnieAI Studio: {0}")]
    Transport(String),
    #[error("Couldn't read UnieAI Studio's response: {0}")]
    Parse(String),
    #[error("Couldn't use the token cache: {0}")]
    Cache(String),
}

/// `client.authentication.k8s.io/v1` ExecCredential, as kubectl reads it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecCredential {
    pub api_version: String,
    pub kind: String,
    pub status: ExecCredentialStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecCredentialStatus {
    pub token: String,
    pub expiration_timestamp: String,
}

impl ExecCredential {
    fn expires_at(&self) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(&self.status.expiration_timestamp)
            .ok()
            .map(|time| time.with_timezone(&Utc))
    }

    fn usable_at(&self, now: DateTime<Utc>) -> bool {
        !self.status.token.is_empty()
            && self
                .expires_at()
                .is_some_and(|at| (at - now).num_seconds() > CACHE_MARGIN_SECS)
    }
}

/// What the cache keeps per vCluster: the credential, the Studio it came from
/// and who it was issued to (so a different sign-in or key never reuses it).
#[derive(Debug, Serialize, Deserialize)]
struct CachedCredential {
    studio_url: String,
    #[serde(default)]
    owner: String,
    credential: ExecCredential,
}

/// Who a token belongs to: the signed-in account, or a digest of the machine key.
fn cache_owner(credentials: Option<&UnieAICredentials>, machine_key: Option<&str>) -> String {
    use sha2::Digest;
    let digest = |text: &str| {
        let hash = sha2::Sha256::digest(text.as_bytes());
        hash.iter()
            .take(12)
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    match (credentials, machine_key) {
        (Some(credentials), _) => match credentials.email.as_deref() {
            Some(email) if !email.trim().is_empty() => format!("user:{}", email.trim()),
            // No email on file: the refresh token stands in for the account.
            _ => format!("login:{}", digest(&credentials.refresh_token)),
        },
        (None, Some(key)) => format!("key:{}", digest(key.trim())),
        (None, None) => String::new(),
    }
}

/// A vCluster id becomes a file name; anything outside `[A-Za-z0-9._-]` is replaced.
fn cache_path(codex_home: &Path, cluster_id: &str) -> PathBuf {
    let safe: String = cluster_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    codex_home.join(CACHE_DIR).join(format!("{safe}.json"))
}

fn read_cache(
    codex_home: &Path,
    cluster_id: &str,
    studio_url: &str,
    owner: &str,
) -> Option<ExecCredential> {
    let text = std::fs::read_to_string(cache_path(codex_home, cluster_id)).ok()?;
    let cached: CachedCredential = serde_json::from_str(&text).ok()?;
    (cached.studio_url == studio_url && !owner.is_empty() && cached.owner == owner)
        .then_some(cached.credential)
}

fn write_cache(
    codex_home: &Path,
    cluster_id: &str,
    studio_url: &str,
    owner: &str,
    credential: &ExecCredential,
) -> io::Result<()> {
    let path = cache_path(codex_home, cluster_id);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    let json = serde_json::to_string(&CachedCredential {
        studio_url: studio_url.to_string(),
        owner: owner.to_string(),
        credential: credential.clone(),
    })
    .map_err(io::Error::other)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path)?;
    file.write_all(json.as_bytes())
}

/// Remove every cached vCluster token. Returns how many were removed.
pub fn clear_kube_token_cache(codex_home: &Path) -> io::Result<usize> {
    let dir = codex_home.join(CACHE_DIR);
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err),
    };
    let mut removed = 0;
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            std::fs::remove_file(path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// The signed-in Studio login, checked against the Studio a kubeconfig names.
fn studio_credentials(
    codex_home: &Path,
    wanted_studio: Option<&str>,
) -> Result<UnieAICredentials, KubeError> {
    let credentials = match load_unieai_credentials(codex_home) {
        Some(credentials) if credentials.account == UnieAIAccountKind::Studio => credentials,
        _ => return Err(KubeError::NotSignedIn),
    };
    if let Some(wanted) = wanted_studio.map(normalize_url).filter(|w| !w.is_empty()) {
        let signed_in = normalize_url(&credentials.studio_url);
        if wanted != signed_in {
            return Err(KubeError::OtherStudio { wanted, signed_in });
        }
    }
    Ok(credentials)
}

/// Studio's error envelope: `{ "error": "message", "code": "..." }` (or a nested
/// `{ "error": { "message" } }` from older routes).
fn error_parts(text: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return (None, None);
    };
    let message = value
        .get("error")
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
        })
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string);
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string);
    (message, code)
}

fn map_failure(status: http::StatusCode, text: &str, cluster_id: &str) -> KubeError {
    let (message, code) = error_parts(text);
    match (status.as_u16(), code.as_deref()) {
        (_, Some("relay_not_configured")) => KubeError::RelayDisabled,
        (404, _) => KubeError::NotFound(cluster_id.to_string()),
        (409, Some("access_pending" | "credential_pending")) => KubeError::Pending,
        (429, _) => KubeError::RateLimited,
        (403, _) => KubeError::NoAccess(
            message.unwrap_or_else(|| "You do not have access to this vCluster.".to_string()),
        ),
        (code, _) if (400..500).contains(&code) => match message {
            Some(message) => KubeError::Rejected(message),
            None => KubeError::Status(code),
        },
        (code, _) => KubeError::Status(code),
    }
}

/// One authenticated Studio call; a 401 refreshes the login once.
async fn studio_call(
    codex_home: &Path,
    credentials: &mut UnieAICredentials,
    method: http::Method,
    path: &str,
    cluster_id: &str,
) -> Result<String, KubeError> {
    let client = create_client();
    ensure_fresh_studio_token(&client, codex_home, credentials, /*force*/ false)
        .await
        .map_err(|_| KubeError::Unauthorized)?;
    let url = format!("{}{path}", credentials.studio_url.trim_end_matches('/'));
    for attempt in 0..2 {
        let response = client
            .request(method.clone(), &url)
            .header("Accept", "application/json")
            .header(
                "Authorization",
                format!("Bearer {}", credentials.access_token),
            )
            .send()
            .await
            .map_err(|err| KubeError::Transport(err.to_string()))?;
        let status = response.status();
        if status == http::StatusCode::UNAUTHORIZED {
            if attempt == 0
                && ensure_fresh_studio_token(&client, codex_home, credentials, true)
                    .await
                    .is_ok()
            {
                continue;
            }
            return Err(KubeError::Unauthorized);
        }
        let text = response
            .text()
            .await
            .map_err(|err| KubeError::Transport(err.to_string()))?;
        if !status.is_success() {
            return Err(map_failure(status, &text, cluster_id));
        }
        return Ok(text);
    }
    Err(KubeError::Unauthorized)
}

fn cluster_path(cluster_id: &str, tail: &str) -> String {
    let encoded: String = cluster_id
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("/api/on-prem/clusters/{encoded}/access/{tail}")
}

/// One Studio call with a machine identity key (no refresh: a 401 is final).
async fn machine_call(
    studio_url: &str,
    key: &str,
    path: &str,
    cluster_id: &str,
) -> Result<String, KubeError> {
    let client = create_client();
    let response = client
        .request(http::Method::POST, format!("{studio_url}{path}"))
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|err| KubeError::Transport(err.to_string()))?;
    let status = response.status();
    if status == http::StatusCode::UNAUTHORIZED {
        return Err(KubeError::MachineKeyRejected);
    }
    let text = response
        .text()
        .await
        .map_err(|err| KubeError::Transport(err.to_string()))?;
    if !status.is_success() {
        return Err(map_failure(status, &text, cluster_id));
    }
    Ok(text)
}

/// A 15-minute token for `cluster_id`, from the cache when it still has more
/// than a minute left. `studio` is the Studio the kubeconfig names, if any.
pub async fn kube_token(
    codex_home: &Path,
    cluster_id: &str,
    studio: Option<&str>,
) -> Result<ExecCredential, KubeError> {
    let machine_key = std::env::var(MACHINE_KEY_ENV)
        .ok()
        .filter(|key| !key.trim().is_empty());
    kube_token_with(
        codex_home,
        cluster_id,
        studio,
        machine_key.as_deref(),
        Utc::now(),
        PENDING_DELAY,
    )
    .await
}

pub(crate) async fn kube_token_with(
    codex_home: &Path,
    cluster_id: &str,
    studio: Option<&str>,
    machine_key: Option<&str>,
    now: DateTime<Utc>,
    pending_delay: Duration,
) -> Result<ExecCredential, KubeError> {
    let cluster_id = cluster_id.trim();
    if cluster_id.is_empty() {
        return Err(KubeError::Rejected(
            "A vCluster id is required (--cluster).".to_string(),
        ));
    }
    // A machine key never shares a cache entry with a person's sign-in.
    let (mut credentials, studio_url, cache_key) = match machine_key {
        Some(_) => {
            let studio_url = studio
                .map(normalize_url)
                .filter(|url| !url.is_empty())
                .ok_or(KubeError::MachineKeyNeedsStudio)?;
            (None, studio_url, format!("machine-{cluster_id}"))
        }
        None => {
            let credentials = studio_credentials(codex_home, studio)?;
            let studio_url = normalize_url(&credentials.studio_url);
            (Some(credentials), studio_url, cluster_id.to_string())
        }
    };
    let owner = cache_owner(credentials.as_ref(), machine_key);
    if let Some(cached) = read_cache(codex_home, &cache_key, &studio_url, &owner)
        && cached.usable_at(now)
    {
        return Ok(cached);
    }
    let path = cluster_path(cluster_id, "token");
    let mut attempt = 0;
    let credential = loop {
        attempt += 1;
        let answer = match (credentials.as_mut(), machine_key) {
            (Some(credentials), _) => {
                studio_call(
                    codex_home,
                    credentials,
                    http::Method::POST,
                    &path,
                    cluster_id,
                )
                .await
            }
            (None, Some(key)) => machine_call(&studio_url, key, &path, cluster_id).await,
            (None, None) => Err(KubeError::NotSignedIn),
        };
        match answer {
            Ok(text) => {
                let credential: ExecCredential =
                    serde_json::from_str(&text).map_err(|err| KubeError::Parse(err.to_string()))?;
                if credential.status.token.is_empty() {
                    return Err(KubeError::Parse("the response held no token".to_string()));
                }
                break credential;
            }
            Err(KubeError::Pending) if attempt < PENDING_ATTEMPTS => {
                tokio::time::sleep(pending_delay).await;
            }
            Err(err) => return Err(err),
        }
    };
    write_cache(codex_home, &cache_key, &studio_url, &owner, &credential)
        .map_err(|err| KubeError::Cache(err.to_string()))?;
    Ok(credential)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KubeconfigResponse {
    kubeconfig: String,
    #[serde(default)]
    file_name: Option<String>,
}

/// A kubeconfig for `cluster_id` whose user runs `unieai kube token`, and the
/// file name Studio suggests for it.
pub async fn kube_kubeconfig(
    codex_home: &Path,
    cluster_id: &str,
) -> Result<(String, String), KubeError> {
    let cluster_id = cluster_id.trim();
    let mut credentials = studio_credentials(codex_home, None)?;
    let text = studio_call(
        codex_home,
        &mut credentials,
        http::Method::GET,
        &cluster_path(cluster_id, "kubeconfig"),
        cluster_id,
    )
    .await?;
    let body: KubeconfigResponse =
        serde_json::from_str(&text).map_err(|err| KubeError::Parse(err.to_string()))?;
    let name = body
        .file_name
        .filter(|name| !name.contains('/') && !name.contains('\\') && !name.is_empty())
        .unwrap_or_else(|| format!("vcluster-{cluster_id}.yaml"));
    Ok((body.kubeconfig, name))
}

#[cfg(test)]
#[path = "unieai_kube_tests.rs"]
mod tests;
