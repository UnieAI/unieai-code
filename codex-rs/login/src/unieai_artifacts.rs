// Copyright (c) 2026 UnieAI. All rights reserved.
//! Artifacts: pages published from UnieAI Code to ava (UnieAI Rabi,
//! `agent.unieai.com`). See `docs/unieai/artifacts-spec.md`.
//!
//! ava serves the routes under `/api/agent-next/artifacts`, authenticated
//! with the Rabi desktop key that `unieai login --rabi` stores in
//! `unieai.json`. The uac engine's `publish_artifact` tool
//! (`agent-runtime/src/unieai-dsh/unieai-artifacts-core.mjs`) speaks the same
//! routes and shares the id memory kept here in `artifacts.json`, so a page
//! published by either one is updated in place by the other.
//!
//! The key is only sent as the Authorization header; errors never contain it.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use serde::Deserialize;
use serde::Serialize;

use crate::default_client::create_client_without_request_logging;
use crate::unieai::UnieAIAccountKind;
use crate::unieai::load_unieai_credentials;

pub const ARTIFACTS_ROUTE: &str = "/api/agent-next/artifacts";
pub const ARTIFACTS_SOURCE: &str = "unieai-code";
pub const ENTRY: &str = "index.html";
const MEMORY_FILE: &str = "artifacts.json";

const MIB: u64 = 1024 * 1024;
/// ava's html-share limits.
pub const MAX_FILE_BYTES: u64 = 4 * MIB;
pub const MAX_DEPS_BYTES: u64 = 12 * MIB;
pub const MAX_DEPS: usize = 48;
pub const MAX_SHARE_BYTES: u64 = 16 * MIB;

/// An artifacts failure, worded for the person at the terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactsError {
    /// ava's code (`too_large`, `external_ref`, `quota_exceeded`,
    /// `version_conflict`) or a local one (`not_rabi`, `unauthorized`, ...).
    pub code: String,
    pub message: String,
    /// On `version_conflict`: the version the page is at now.
    pub current_version: Option<i64>,
}

impl ArtifactsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            current_version: None,
        }
    }
}

impl fmt::Display for ArtifactsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ArtifactsError {}

type Result<T> = std::result::Result<T, ArtifactsError>;

/// The ava account to publish with: the stored Rabi login.
#[derive(Clone)]
pub struct ArtifactsAccount {
    pub base_url: String,
    api_key: String,
    /// Scopes the id memory: `<rabi url>|<email>`.
    pub account: String,
}

impl fmt::Debug for ArtifactsAccount {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArtifactsAccount")
            .field("base_url", &self.base_url)
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

impl ArtifactsAccount {
    pub fn new(base_url: &str, api_key: &str, account: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
            account: account.to_string(),
        }
    }
}

/// Reads the Rabi login from `unieai.json`; a Studio login is told to link Rabi.
pub fn artifacts_account(codex_home: &Path) -> Result<ArtifactsAccount> {
    let Some(credentials) = load_unieai_credentials(codex_home) else {
        return Err(ArtifactsError::new(
            "not_signed_in",
            "Publishing artifacts needs a UnieAI Rabi sign-in (agent.unieai.com). Run `unieai login --rabi` first.",
        ));
    };
    if credentials.account != UnieAIAccountKind::Rabi {
        return Err(ArtifactsError::new(
            "not_rabi",
            "Artifacts are hosted by UnieAI Rabi (agent.unieai.com), and this machine is signed in to UnieAI Studio, whose key Rabi does not accept. \
             Link a Rabi account with `unieai login --rabi` (it replaces the Studio sign-in here; Studio single sign-on is planned).",
        ));
    }
    let base_url = credentials.studio_url.trim_end_matches('/').to_string();
    if base_url.is_empty() || credentials.gateway_api_key.is_empty() {
        return Err(ArtifactsError::new(
            "not_signed_in",
            "The stored Rabi sign-in is incomplete. Run `unieai login --rabi` again.",
        ));
    }
    let account = format!(
        "{base_url}|{}",
        credentials.email.as_deref().unwrap_or_default()
    );
    Ok(ArtifactsAccount::new(
        &base_url,
        &credentials.gateway_api_key,
        &account,
    ))
}

// --- the site -----------------------------------------------------------------

/// One file of a page, as uploaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub fn mime_of(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn read_file(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path)
        .map_err(|err| ArtifactsError::new("io", format!("cannot read {}: {err}", path.display())))
}

/// The files to upload from `path`: an `.html` file becomes `index.html`; a
/// directory must have `index.html` at its top and is uploaded whole
/// (dot-files and `node_modules` skipped).
pub fn collect_site(path: &Path) -> Result<Vec<SiteFile>> {
    let meta = std::fs::metadata(path).map_err(|_| {
        ArtifactsError::new("not_found", format!("{} does not exist.", path.display()))
    })?;
    if meta.is_file() {
        let is_html = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"));
        if !is_html {
            return Err(ArtifactsError::new(
                "not_html",
                format!(
                    "{} is not an HTML page. Publish an .html file or a directory with index.html at its top.",
                    path.display()
                ),
            ));
        }
        return Ok(vec![SiteFile {
            path: ENTRY.to_string(),
            bytes: read_file(path)?,
        }]);
    }
    if !path.join(ENTRY).is_file() {
        return Err(ArtifactsError::new(
            "no_entry",
            format!(
                "{} has no index.html at its top; the page's entry must be index.html.",
                path.display()
            ),
        ));
    }
    let mut files = Vec::new();
    walk(path, path, &mut files)?;
    Ok(files)
}

fn walk(root: &Path, dir: &Path, files: &mut Vec<SiteFile>) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|err| ArtifactsError::new("io", format!("cannot read {}: {err}", dir.display())))?
        .filter_map(std::result::Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let full = entry.path();
        if full.is_dir() {
            walk(root, &full, files)?;
        } else if full.is_file() {
            if files.len() > MAX_DEPS + 1 {
                return Err(ArtifactsError::new(
                    "too_large",
                    format!(
                        "{} has more than {MAX_DEPS} files besides index.html (ava's limit).",
                        root.display()
                    ),
                ));
            }
            let relative = full.strip_prefix(root).unwrap_or(&full);
            let path = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            files.push(SiteFile {
                path,
                bytes: read_file(&full)?,
            });
        }
    }
    Ok(())
}

fn fmt_bytes(n: u64) -> String {
    if n >= MIB {
        format!("{:.1} MiB", n as f64 / MIB as f64)
    } else if n >= 1024 {
        format!("{:.1} KiB", n as f64 / 1024.0)
    } else {
        format!("{n} B")
    }
}

/// ava's limits, checked before the upload. (External references are left
/// to ava's preflight here; the uac tool checks them locally.)
pub fn validate_site(files: &[SiteFile]) -> Result<()> {
    let mut problems = Vec::new();
    if !files.iter().any(|file| file.path == ENTRY) {
        problems.push("There is no index.html.".to_string());
    }
    for file in files {
        let size = file.bytes.len() as u64;
        if size > MAX_FILE_BYTES {
            problems.push(format!(
                "{} is {}; the limit is {} per file.",
                file.path,
                fmt_bytes(size),
                fmt_bytes(MAX_FILE_BYTES)
            ));
        }
    }
    let deps: Vec<_> = files.iter().filter(|file| file.path != ENTRY).collect();
    if deps.len() > MAX_DEPS {
        problems.push(format!(
            "{} files besides index.html; the limit is {MAX_DEPS}.",
            deps.len()
        ));
    }
    let dep_bytes: u64 = deps.iter().map(|file| file.bytes.len() as u64).sum();
    if dep_bytes > MAX_DEPS_BYTES {
        problems.push(format!(
            "The files besides index.html total {}; the limit is {}.",
            fmt_bytes(dep_bytes),
            fmt_bytes(MAX_DEPS_BYTES)
        ));
    }
    let total: u64 = files.iter().map(|file| file.bytes.len() as u64).sum();
    if total > MAX_SHARE_BYTES {
        problems.push(format!(
            "The page totals {}; the limit is {} per page.",
            fmt_bytes(total),
            fmt_bytes(MAX_SHARE_BYTES)
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(ArtifactsError::new(
            "too_large",
            format!("Not published: {}", problems.join(" ")),
        ))
    }
}

/// The page's own `<title>`.
pub fn title_of(files: &[SiteFile]) -> Option<String> {
    let entry = files.iter().find(|file| file.path == ENTRY)?;
    let text = String::from_utf8_lossy(&entry.bytes);
    let lower = text.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let title = text[start..end]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

// --- HTTP ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub path: String,
    /// Sent for completeness; ava decides the type from the extension.
    pub mime: String,
    pub content_base64: String,
}

/// The viewer's header bar. A field left out keeps ava's default
/// (`showAuthor` is false).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactHeader {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_author: Option<bool>,
}

impl ArtifactHeader {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

/// The POST/PUT body. An update without `visibility` or `header` keeps the
/// page's own.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SiteUpload {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub entry: String,
    pub files: Vec<UploadFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<ArtifactHeader>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<i64>,
}

impl SiteUpload {
    pub fn new(title: String, description: Option<String>, files: &[SiteFile]) -> Self {
        let engine = base64::engine::general_purpose::STANDARD;
        Self {
            title,
            description,
            entry: ENTRY.to_string(),
            files: files
                .iter()
                .map(|file| UploadFile {
                    path: file.path.clone(),
                    mime: mime_of(&file.path).to_string(),
                    content_base64: engine.encode(&file.bytes),
                })
                .collect(),
            visibility: None,
            org_id: None,
            header: None,
            expected_version: None,
        }
    }
}

/// The PATCH body: visibility and header only. `header: Some(None)` clears it.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<Option<ArtifactHeader>>,
}

/// ava's limit on one request body.
pub const MAX_BODY_BYTES: u64 = 23 * MIB;

fn check_body_size(body: &impl Serialize) -> Result<()> {
    let size = serde_json::to_vec(body)
        .map(|bytes| bytes.len() as u64)
        .unwrap_or(0);
    if size > MAX_BODY_BYTES {
        return Err(ArtifactsError::new(
            "too_large",
            format!(
                "Not published: the upload is {} once encoded; ava takes at most {} per request.",
                fmt_bytes(size),
                fmt_bytes(MAX_BODY_BYTES)
            ),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Published {
    pub id: String,
    #[serde(default)]
    pub viewer_url: String,
    #[serde(default)]
    pub version: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub viewer_url: Option<String>,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl ArtifactSummary {
    pub fn link(&self) -> &str {
        self.viewer_url.as_deref().unwrap_or(&self.url)
    }
}

/// `GET ?mine=1`: the user's pages from UnieAI Code, those shared with their
/// org, and the quota.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct ArtifactList {
    #[serde(default)]
    pub mine: Vec<ArtifactSummary>,
    #[serde(default)]
    pub org: Vec<ArtifactSummary>,
    #[serde(default)]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub limits: Option<serde_json::Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    current_version: Option<i64>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    reference: Option<String>,
    #[serde(default)]
    issues: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    #[serde(default)]
    error: Option<ErrorBody>,
    #[serde(default)]
    current_version: Option<i64>,
}

fn error_hint(code: &str) -> Option<&'static str> {
    Some(match code {
        "too_large" => {
            "Limits: 4 MiB per file, 12 MiB and 48 files besides index.html, 16 MiB per page, 23 MiB per request."
        }
        "external_ref" => {
            "Inline it, or use cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com or Google Fonts."
        }
        "quota_exceeded" => {
            "The quota is 100 active pages (shared with pages published from ava chats) and 256 MiB: delete pages you no longer need."
        }
        "not_uploadable" => {
            "That page was published from an ava chat; only pages published from UnieAI Code can be replaced. Publish without --id for a new page."
        }
        "org_required" => "You belong to several organizations: choose one with --org-id.",
        "org_forbidden" => "You are not a member of that organization.",
        _ => return None,
    })
}

/// The routes under `/api/agent-next/artifacts`.
pub struct ArtifactsClient {
    client: codex_http_client::HttpClient,
    account: ArtifactsAccount,
}

impl ArtifactsClient {
    pub fn new(account: ArtifactsAccount) -> Self {
        Self {
            client: create_client_without_request_logging(),
            account,
        }
    }

    pub fn account(&self) -> &ArtifactsAccount {
        &self.account
    }

    /// An absolute viewer URL (ava may answer with a path).
    pub fn absolute(&self, url: &str) -> String {
        if url.starts_with("http://") || url.starts_with("https://") || url.is_empty() {
            url.to_string()
        } else {
            format!(
                "{}{}{url}",
                self.account.base_url,
                if url.starts_with('/') { "" } else { "/" }
            )
        }
    }

    async fn request(
        &self,
        method: http::Method,
        path: &str,
        body: Option<&(dyn erased::Body + Sync)>,
    ) -> Result<Option<serde_json::Value>> {
        let url = format!("{}{ARTIFACTS_ROUTE}{path}", self.account.base_url);
        let mut request = self
            .client
            .request(method, url.as_str())
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {}", self.account.api_key));
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body.to_json());
        }
        let response = request.send().await.map_err(|err| {
            ArtifactsError::new(
                "network",
                format!("Could not reach {}: {err}", self.account.base_url),
            )
        })?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(None);
            }
            return serde_json::from_str(&text).map(Some).map_err(|err| {
                ArtifactsError::new("bad_response", format!("ava answered with bad JSON: {err}"))
            });
        }
        Err(self.error_of(status.as_u16(), &text))
    }

    fn error_of(&self, status: u16, text: &str) -> ArtifactsError {
        let envelope: ErrorEnvelope = serde_json::from_str(text).unwrap_or_default();
        let has_error = envelope.error.is_some();
        let body = envelope.error.unwrap_or_default();
        let scrub = |value: &str| value.replace(&self.account.api_key, "[key]");
        let message = scrub(body.message.as_deref().unwrap_or_default());
        let code = body.code.clone().unwrap_or_else(|| {
            if status == 409 {
                "version_conflict".to_string()
            } else {
                format!("http_{status}")
            }
        });
        if code == "version_conflict" {
            let current = body.current_version.or(envelope.current_version);
            return ArtifactsError {
                code,
                message: format!(
                    "The page changed elsewhere: it is at version {}. Publish with --force to overwrite it.",
                    current.map_or_else(|| "?".to_string(), |v| v.to_string())
                ),
                current_version: current,
            };
        }
        let org_error = code == "org_required" || code == "org_forbidden";
        if status == 401 || (status == 403 && !org_error) {
            return ArtifactsError::new(
                "unauthorized",
                format!(
                    "ava refused the Rabi key (HTTP {status}). Publishing needs a desktop key with the `artifacts` scope; run `unieai login --rabi` again to re-grant."
                ),
            );
        }
        if status == 404 && !has_error {
            return ArtifactsError::new(
                "not_found",
                format!(
                    "{} answered 404: the artifact does not exist, or this ava deployment does not serve artifact publishing yet.",
                    self.account.base_url
                ),
            );
        }
        let mut detail = if message.is_empty() {
            let clipped: String = scrub(text).chars().take(300).collect();
            if clipped.is_empty() {
                format!("HTTP {status}")
            } else {
                clipped
            }
        } else {
            message
        };
        let place = [body.path.as_deref(), body.reference.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        if !place.is_empty() && !detail.contains(&place) {
            detail.push_str(&format!(" ({place})"));
        }
        if let Some(hint) = error_hint(&code) {
            detail.push_str(&format!(" {hint}"));
        }
        for issue in body.issues.unwrap_or_default().iter().take(20) {
            let line = issue
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| issue.to_string());
            detail.push_str(&format!("\n- {}", scrub(&line)));
        }
        ArtifactsError::new(&code, format!("ava refused it ({code}): {detail}"))
    }

    fn parse<T: serde::de::DeserializeOwned>(value: Option<serde_json::Value>) -> Result<T> {
        serde_json::from_value(value.unwrap_or(serde_json::Value::Null)).map_err(|err| {
            ArtifactsError::new("bad_response", format!("ava answered unexpectedly: {err}"))
        })
    }

    /// POST /site; a page without a visibility is private.
    pub async fn create(&self, body: &SiteUpload) -> Result<Published> {
        let body = SiteUpload {
            visibility: body
                .visibility
                .clone()
                .or_else(|| Some("private".to_string())),
            ..body.clone()
        };
        check_body_size(&body)?;
        Self::parse(
            self.request(http::Method::POST, "/site", Some(&body))
                .await?,
        )
    }

    pub async fn update(
        &self,
        id: &str,
        body: &SiteUpload,
        expected_version: i64,
    ) -> Result<Published> {
        let body = SiteUpload {
            expected_version: Some(expected_version),
            ..body.clone()
        };
        check_body_size(&body)?;
        Self::parse(
            self.request(http::Method::PUT, &format!("/{}", encode(id)), Some(&body))
                .await?,
        )
    }

    /// PATCH: visibility and header only.
    pub async fn update_settings(&self, id: &str, patch: &SettingsPatch) -> Result<Published> {
        Self::parse(
            self.request(
                http::Method::PATCH,
                &format!("/{}", encode(id)),
                Some(patch),
            )
            .await?,
        )
    }

    pub async fn list(&self) -> Result<ArtifactList> {
        let value = self
            .request(
                http::Method::GET,
                &format!("?mine=1&source={ARTIFACTS_SOURCE}"),
                None,
            )
            .await?;
        Self::parse(value)
    }

    /// Metadata plus files, as ava returns them.
    pub async fn get(&self, id: &str) -> Result<serde_json::Value> {
        Ok(self
            .request(http::Method::GET, &format!("/{}", encode(id)), None)
            .await?
            .unwrap_or(serde_json::Value::Null))
    }

    pub async fn delete(&self, id: &str, expected_version: Option<i64>) -> Result<()> {
        let query = expected_version
            .map(|version| format!("?expectedVersion={version}"))
            .unwrap_or_default();
        self.request(
            http::Method::DELETE,
            &format!("/{}{query}", encode(id)),
            None,
        )
        .await
        .map(|_| ())
    }
}

/// A request body of any shape, as JSON (object-safe for `request`).
mod erased {
    pub trait Body {
        fn to_json(&self) -> String;
    }

    impl<T: serde::Serialize> Body for T {
        fn to_json(&self) -> String {
            serde_json::to_string(self).unwrap_or_default()
        }
    }
}

fn encode(id: &str) -> String {
    urlencoding::encode(id).into_owned()
}

// --- id memory ----------------------------------------------------------------

/// One remembered page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub account: String,
    #[serde(default)]
    pub viewer_url: String,
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct MemoryFile {
    version: u32,
    /// workspace root -> path relative to it (or absolute) -> entry.
    workspaces: BTreeMap<String, BTreeMap<String, MemoryEntry>>,
}

impl Default for MemoryFile {
    fn default() -> Self {
        Self {
            version: 1,
            workspaces: BTreeMap::new(),
        }
    }
}

/// `$UNIEAI_HOME/artifacts.json`, shared with the uac tool: a workspace and a
/// source path -> the page it was published as. It lives in the UnieAI home,
/// not the project's `.unieai/`, because an id belongs to the account, and
/// `.unieai/` is checked into repositories.
pub struct IdMemory {
    file: PathBuf,
}

/// The workspace paths are remembered under: the git root, else `cwd`.
pub fn workspace_root(cwd: &Path) -> PathBuf {
    let mut dir = cwd.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return cwd.to_path_buf();
        }
    }
}

impl IdMemory {
    pub fn new(codex_home: &Path) -> Self {
        Self {
            file: codex_home.join(MEMORY_FILE),
        }
    }

    fn load(&self) -> MemoryFile {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, data: &MemoryFile) -> std::io::Result<()> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self
            .file
            .with_extension(format!("json.{}.tmp", std::process::id()));
        let json = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, format!("{json}\n"))?;
        std::fs::rename(tmp, &self.file)
    }

    fn key(workspace: &Path, path: &Path) -> String {
        match path.strip_prefix(workspace) {
            Ok(relative) if !relative.as_os_str().is_empty() => relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/"),
            _ => path.to_string_lossy().to_string(),
        }
    }

    pub fn lookup(&self, workspace: &Path, path: &Path, account: &str) -> Option<MemoryEntry> {
        self.load()
            .workspaces
            .get(&workspace.to_string_lossy().to_string())?
            .get(&Self::key(workspace, path))
            .filter(|entry| entry.account == account)
            .cloned()
    }

    pub fn remember(
        &self,
        workspace: &Path,
        path: &Path,
        mut entry: MemoryEntry,
    ) -> std::io::Result<()> {
        let mut data = self.load();
        let key = Self::key(workspace, path);
        let paths = data
            .workspaces
            .entry(workspace.to_string_lossy().to_string())
            .or_default();
        paths.retain(|other_key, other| other.id != entry.id || *other_key == key);
        entry.updated_at =
            Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        paths.insert(key, entry);
        self.save(&data)
    }

    /// Local paths remembered for `id`.
    pub fn paths_of(&self, id: &str) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for (workspace, paths) in self.load().workspaces {
            for (path, entry) in paths {
                if entry.id == id {
                    let path = PathBuf::from(&path);
                    out.push(if path.is_absolute() {
                        path
                    } else {
                        Path::new(&workspace).join(path)
                    });
                }
            }
        }
        out
    }

    pub fn forget(&self, id: &str) -> std::io::Result<bool> {
        let mut data = self.load();
        let before: usize = data.workspaces.values().map(BTreeMap::len).sum();
        for paths in data.workspaces.values_mut() {
            paths.retain(|_, entry| entry.id != id);
        }
        data.workspaces.retain(|_, paths| !paths.is_empty());
        let after: usize = data.workspaces.values().map(BTreeMap::len).sum();
        if before == after {
            return Ok(false);
        }
        self.save(&data)?;
        Ok(true)
    }
}

// --- publish ------------------------------------------------------------------

/// What `publish` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishOutcome {
    pub id: String,
    pub viewer_url: String,
    pub version: i64,
    pub title: String,
    pub created: bool,
}

/// What to publish.
#[derive(Debug, Clone, Default)]
pub struct PublishRequest {
    pub path: PathBuf,
    pub title: Option<String>,
    pub description: Option<String>,
    pub id: Option<String>,
    /// `private` or `org`; an update without it keeps the page's.
    pub visibility: Option<String>,
    /// The org for `org` visibility when the user is in several.
    pub org_id: Option<String>,
    /// On a version conflict, overwrite the current version.
    pub force: bool,
}

/// Publishes `request.path`: updates the page it was published as before (or
/// `request.id`), else creates one; remembers the path -> id.
pub async fn publish(
    client: &ArtifactsClient,
    memory: &IdMemory,
    workspace: &Path,
    request: PublishRequest,
) -> Result<PublishOutcome> {
    let files = collect_site(&request.path)?;
    validate_site(&files)?;
    let account = client.account().account.clone();
    let remembered = memory.lookup(workspace, &request.path, &account);
    let title = request
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .or_else(|| title_of(&files))
        .or_else(|| remembered.as_ref().map(|entry| entry.title.clone()))
        .unwrap_or_else(|| "Untitled page".to_string());
    let mut body = SiteUpload::new(title.clone(), request.description.clone(), &files);
    body.visibility = request.visibility.clone();
    body.org_id = request.org_id.clone();
    let id = request
        .id
        .clone()
        .or_else(|| remembered.as_ref().map(|entry| entry.id.clone()));

    let (published, created) = match id {
        None => (client.create(&body).await?, true),
        Some(id) => {
            let expected = match remembered.as_ref().filter(|entry| entry.id == id) {
                Some(MemoryEntry {
                    version: Some(version),
                    ..
                }) => Some(*version),
                _ => None,
            };
            let expected = match expected {
                Some(version) => Ok(version),
                None => client.get(&id).await.map(|meta| {
                    meta.get("version")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0)
                }),
            };
            let attempt = match expected {
                Ok(version) => client.update(&id, &body, version).await,
                Err(err) => Err(err),
            };
            match attempt {
                Ok(published) => (published, false),
                Err(err) if err.code == "not_found" && request.id.is_none() => {
                    // The remembered page was deleted in ava: make a new one.
                    let _ = memory.forget(&id);
                    (client.create(&body).await?, true)
                }
                Err(err) if err.code == "version_conflict" && request.force => {
                    let current = match err.current_version {
                        Some(version) => version,
                        None => client
                            .get(&id)
                            .await?
                            .get("version")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0),
                    };
                    (client.update(&id, &body, current).await?, false)
                }
                Err(err) => return Err(err),
            }
        }
    };
    let outcome = PublishOutcome {
        id: published.id.clone(),
        viewer_url: client.absolute(&published.viewer_url),
        version: published.version,
        title,
        created,
    };
    memory
        .remember(
            workspace,
            &request.path,
            MemoryEntry {
                id: outcome.id.clone(),
                account,
                viewer_url: outcome.viewer_url.clone(),
                version: Some(outcome.version),
                title: outcome.title.clone(),
                updated_at: None,
            },
        )
        .map_err(|err| {
            ArtifactsError::new(
                "io",
                format!("published, but could not save {MEMORY_FILE}: {err}"),
            )
        })?;
    Ok(outcome)
}

/// Opens a viewer URL in the default browser.
pub fn open_in_browser(url: &str) -> std::io::Result<()> {
    webbrowser::open(url)
}

#[cfg(test)]
#[path = "unieai_artifacts_tests.rs"]
mod tests;
