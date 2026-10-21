// Copyright (c) 2026 UnieAI. All rights reserved.
//! Connected model APIs: OpenAI-compatible endpoints the user brings
//! themselves. Either a provider from [`API_PRESETS`] (OpenAI, OpenRouter,
//! DeepSeek, Groq, Together, Mistral, Gemini, a local Ollama or LM Studio),
//! or any URL: a self-hosted server (vLLM, SGLang, TGI, llama.cpp server, …)
//! on this machine or another one. Both are the same thing to UnieAI Code;
//! a preset only fills in the URL, the default name and the label, and says
//! whether a key is required.
//!
//! Each server is a named provider kept in `$CODEX_HOME/unieai-self-hosted.json`
//! (owner-only, like `unieai.json`): its `/v1` base URL, an optional API key
//! (stored, or read from an environment variable at use), and its models with
//! an optional context window and vision flag each. It needs no UnieAI
//! account; a Studio login and any number of servers can sit side by side.
//!
//! A model of a server is addressed as `<provider id>/<model id>` wherever
//! UnieAI Code names models (config.toml `model`, the /model picker, the uac
//! engine), so the same model id on two servers, or on a server and the
//! Studio gateway, stays unambiguous. Servers speak chat completions; the
//! codex engine only speaks the Responses API, so these models run on the uac
//! engine (see `docs/unieai/login.md`). OpenAI itself speaks the Responses
//! API too, so its preset also runs on the codex engine through
//! `model_provider = "<provider id>"`.

use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use codex_model_provider_info::ModelProviderInfo;
use codex_model_provider_info::WireApi;

use crate::default_client::create_client;

const SELF_HOSTED_FILE: &str = "unieai-self-hosted.json";
const STORE_VERSION: u32 = 1;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ID_LEN: usize = 32;

/// At most this many models of one provider are kept: a provider such as
/// OpenRouter lists hundreds, which would bury the /model picker. Narrow the
/// list with a filter (onboarding) or pin models with `--model` (CLI).
pub const MAX_STORED_MODELS: usize = 50;

/// `kind` of a provider connected by URL rather than from a preset.
pub const CUSTOM_KIND: &str = "custom";

/// A model API a user can connect by picking it rather than typing its URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApiPreset {
    /// Stored as the provider's `kind`; also what `--api <preset>` takes.
    pub kind: &'static str,
    /// What the UI calls the provider and its models ("OpenRouter").
    pub label: &'static str,
    pub base_url: &'static str,
    /// The provider id when the user names none. Never a built-in provider
    /// id (`openai`, `ollama`, `lmstudio` are taken), see [`validate_provider_id`].
    pub default_id: &'static str,
    /// Cloud APIs refuse every request without a key; local servers need none.
    pub key_required: bool,
    /// The API also serves the Responses API, so the codex engine can use it.
    pub codex_engine: bool,
    /// Other spellings `--api` accepts.
    pub aliases: &'static [&'static str],
}

/// The providers offered before "Custom URL", in the order shown.
pub const API_PRESETS: &[ApiPreset] = &[
    ApiPreset {
        kind: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com/v1",
        default_id: "openai-api",
        key_required: true,
        codex_engine: true,
        aliases: &[],
    },
    ApiPreset {
        kind: "openrouter",
        label: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        default_id: "openrouter",
        key_required: true,
        codex_engine: false,
        aliases: &[],
    },
    ApiPreset {
        kind: "deepseek",
        label: "DeepSeek",
        base_url: "https://api.deepseek.com/v1",
        default_id: "deepseek",
        key_required: true,
        codex_engine: false,
        aliases: &[],
    },
    ApiPreset {
        kind: "groq",
        label: "Groq",
        base_url: "https://api.groq.com/openai/v1",
        default_id: "groq",
        key_required: true,
        codex_engine: false,
        aliases: &[],
    },
    ApiPreset {
        kind: "together",
        label: "Together",
        base_url: "https://api.together.xyz/v1",
        default_id: "together",
        key_required: true,
        codex_engine: false,
        aliases: &["togetherai", "together-ai"],
    },
    ApiPreset {
        kind: "mistral",
        label: "Mistral",
        base_url: "https://api.mistral.ai/v1",
        default_id: "mistral",
        key_required: true,
        codex_engine: false,
        aliases: &[],
    },
    ApiPreset {
        kind: "gemini",
        label: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        default_id: "gemini",
        key_required: true,
        codex_engine: false,
        aliases: &["google"],
    },
    ApiPreset {
        kind: "ollama",
        label: "Ollama",
        base_url: "http://localhost:11434/v1",
        default_id: "ollama-local",
        key_required: false,
        codex_engine: false,
        aliases: &[],
    },
    ApiPreset {
        kind: "lmstudio",
        label: "LM Studio",
        base_url: "http://localhost:1234/v1",
        default_id: "lmstudio-local",
        key_required: false,
        codex_engine: false,
        aliases: &["lm-studio"],
    },
];

/// The preset `name` names (its kind or an alias, any case).
pub fn api_preset(name: &str) -> Option<&'static ApiPreset> {
    let name = name.trim().to_ascii_lowercase();
    API_PRESETS
        .iter()
        .find(|preset| preset.kind == name || preset.aliases.contains(&name.as_str()))
}

/// Model ids that are not chat models (embeddings, speech, images,
/// moderation, …): a coding agent cannot use them, so discovery skips them.
const NON_CHAT_MODEL_MARKERS: &[&str] = &[
    "embed",
    "whisper",
    "tts",
    "dall-e",
    "moderation",
    "transcribe",
    "rerank",
    "gpt-image",
    "imagen",
    "davinci",
    "babbage",
    "realtime",
    "sora",
];

/// Whether a discovered model id looks like a chat model.
pub fn is_chat_model_id(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    !NON_CHAT_MODEL_MARKERS
        .iter()
        .any(|marker| id.contains(marker))
}

/// Whether `id` matches a user's filter: every whitespace-separated term
/// appears in it, ignoring case. An empty filter matches everything.
pub fn model_matches_filter(id: &str, filter: &str) -> bool {
    let id = id.to_ascii_lowercase();
    filter
        .split_whitespace()
        .all(|term| id.contains(&term.to_ascii_lowercase()))
}

/// Context window assumed for a model whose server declares none: small
/// enough that compaction runs before a typical local deployment overflows.
pub const DEFAULT_SELF_HOSTED_CONTEXT_WINDOW: i64 = 32_768;

/// Provider ids that already mean something to UnieAI Code.
const RESERVED_IDS: &[&str] = &[
    "unieai",
    "openai",
    "ollama",
    "lmstudio",
    "oss",
    "amazon-bedrock",
    "amazon-bedrock-runtime",
];

/// One connected model API (a preset provider or a self-hosted server).
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct SelfHostedProvider {
    /// The provider id: lower-case letters, digits, `-` and `_`.
    pub id: String,
    /// The [`ApiPreset`] kind it was connected as (`"openrouter"`), or
    /// [`CUSTOM_KIND`]. Absent in files written before presets existed:
    /// those are custom servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// What the UI calls it; the id when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The OpenAI-compatible base URL, ending in `/v1` (or the server's
    /// equivalent).
    pub base_url: String,
    /// A key stored at login (`--with-api-key` or onboarding). Never printed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// The environment variable that holds the key (`--api-key-env`), read
    /// whenever the server is used instead of storing the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub models: Vec<SelfHostedModel>,
    /// The models were given by hand (`--model`) rather than discovered.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manual_models: bool,
}

/// The key stays out of logs and error messages.
impl fmt::Debug for SelfHostedProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SelfHostedProvider")
            .field("id", &self.id)
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("api_key_env", &self.api_key_env)
            .field("models", &self.models)
            .field("manual_models", &self.manual_models)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SelfHostedModel {
    pub id: String,
    /// The model's context window in tokens, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<i64>,
    /// Whether the model accepts images.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub vision: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SelfHostedStore {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    providers: Vec<SelfHostedProvider>,
}

impl SelfHostedProvider {
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.id)
    }

    /// The preset it was connected as; none for a custom server.
    pub fn preset(&self) -> Option<&'static ApiPreset> {
        self.kind.as_deref().and_then(api_preset)
    }

    /// How the /model picker and status output label this provider's
    /// models: the preset's name ("OpenRouter", with the provider id when
    /// it is not the default one), else `Self-hosted: <name>`.
    pub fn label(&self) -> String {
        match self.preset() {
            Some(preset) if self.id == preset.default_id => preset.label.to_string(),
            Some(preset) => format!("{} ({})", preset.label, self.id),
            None => format!("Self-hosted: {}", self.display_name()),
        }
    }

    /// Whether the codex engine can use it: only APIs that serve the
    /// Responses API (OpenAI). The rest speak chat completions, uac only.
    pub fn runs_on_codex_engine(&self) -> bool {
        self.preset().is_some_and(|preset| preset.codex_engine)
    }

    /// The key to send: the stored one, else the named environment variable.
    pub fn resolve_api_key(&self) -> Option<String> {
        self.api_key
            .clone()
            .or_else(|| {
                self.api_key_env
                    .as_deref()
                    .and_then(|var| std::env::var(var).ok())
            })
            .filter(|key| !key.trim().is_empty())
    }

    /// How the key is configured, for status output (never the key itself).
    pub fn key_source(&self) -> String {
        match (&self.api_key, &self.api_key_env) {
            (Some(_), _) => "stored API key".to_string(),
            (None, Some(var)) => format!("API key from ${var}"),
            (None, None) => "no API key".to_string(),
        }
    }

    /// `<provider id>/<model id>`: how UnieAI Code names this server's model.
    pub fn slug(&self, model_id: &str) -> String {
        format!("{}/{model_id}", self.id)
    }

    /// This server as a codex model provider. The codex engine speaks only
    /// the Responses API, so it works for servers that serve `/responses`
    /// too (selected with `model_provider = "<id>"`); the uac engine uses
    /// chat completions and does not go through this.
    pub fn model_provider_info(&self) -> ModelProviderInfo {
        ModelProviderInfo {
            name: self.display_name().to_string(),
            base_url: Some(self.base_url.clone()),
            env_key: self
                .api_key
                .is_none()
                .then(|| self.api_key_env.clone())
                .flatten(),
            experimental_bearer_token: self.api_key.clone().map(Into::into),
            wire_api: WireApi::Responses,
            // As for the UnieAI gateway: open-model servers reject the
            // OpenAI-only namespace tool type. OpenAI itself takes it.
            namespace_tools: (!self.runs_on_codex_engine()).then_some(false),
            requires_openai_auth: false,
            ..Default::default()
        }
    }
}

pub fn self_hosted_path(codex_home: &Path) -> PathBuf {
    codex_home.join(SELF_HOSTED_FILE)
}

/// The configured servers; none when the file is absent or unreadable.
pub fn load_self_hosted_providers(codex_home: &Path) -> Vec<SelfHostedProvider> {
    match read_self_hosted_providers(codex_home) {
        Ok(providers) => providers,
        Err(err) => {
            tracing::warn!("ignoring {}: {err}", self_hosted_path(codex_home).display());
            Vec::new()
        }
    }
}

/// Like [`load_self_hosted_providers`], but a malformed file is an error.
pub fn read_self_hosted_providers(codex_home: &Path) -> io::Result<Vec<SelfHostedProvider>> {
    let contents = match std::fs::read_to_string(self_hosted_path(codex_home)) {
        Ok(contents) => contents,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let store: SelfHostedStore = serde_json::from_str(&contents)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok(store.providers)
}

pub fn save_self_hosted_providers(
    codex_home: &Path,
    providers: &[SelfHostedProvider],
) -> io::Result<()> {
    std::fs::create_dir_all(codex_home)?;
    let store = SelfHostedStore {
        version: STORE_VERSION,
        providers: providers.to_vec(),
    };
    let json = serde_json::to_string_pretty(&store).map_err(io::Error::other)?;
    let path = self_hosted_path(codex_home);
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(&path)?;
    file.write_all(json.as_bytes())?;
    file.write_all(b"\n")?;
    // A file created by an older build may be wider than owner-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Adds `provider`, replacing a server of the same id.
pub fn upsert_self_hosted_provider(
    codex_home: &Path,
    provider: SelfHostedProvider,
) -> io::Result<()> {
    let mut providers = read_self_hosted_providers(codex_home)?;
    match providers.iter_mut().find(|p| p.id == provider.id) {
        Some(existing) => *existing = provider,
        None => providers.push(provider),
    }
    save_self_hosted_providers(codex_home, &providers)
}

/// Removes the server `id`; false when there was none.
pub fn remove_self_hosted_provider(codex_home: &Path, id: &str) -> io::Result<bool> {
    let mut providers = read_self_hosted_providers(codex_home)?;
    let before = providers.len();
    providers.retain(|p| p.id != id);
    if providers.len() == before {
        return Ok(false);
    }
    if providers.is_empty() {
        match std::fs::remove_file(self_hosted_path(codex_home)) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        return Ok(true);
    }
    save_self_hosted_providers(codex_home, &providers)?;
    Ok(true)
}

/// The server and model a `<provider id>/<model id>` slug names, if any.
pub fn find_self_hosted_model<'a>(
    providers: &'a [SelfHostedProvider],
    slug: &str,
) -> Option<(&'a SelfHostedProvider, &'a SelfHostedModel)> {
    let (id, model) = slug.split_once('/')?;
    let provider = providers.iter().find(|p| p.id == id)?;
    let model = provider.models.iter().find(|m| m.id == model)?;
    Some((provider, model))
}

/// Whether `slug` names a model of a configured self-hosted server.
pub fn is_self_hosted_model(codex_home: &Path, slug: &str) -> bool {
    find_self_hosted_model(&load_self_hosted_providers(codex_home), slug).is_some()
}

/// A user-typed server URL as a base URL: `http://` when no scheme is given
/// (self-hosted servers usually run without TLS), no trailing slash or
/// pasted endpoint path, and `/v1` when the URL has no path at all.
pub fn normalize_base_url(raw: &str) -> Result<String, SelfHostedError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(SelfHostedError::InvalidUrl("the URL is empty".to_string()));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = url::Url::parse(&with_scheme)
        .map_err(|err| SelfHostedError::InvalidUrl(format!("{trimmed}: {err}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(SelfHostedError::InvalidUrl(format!(
            "{trimmed}: expected an http:// or https:// URL"
        )));
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    for endpoint in ["/chat/completions", "/completions", "/models", "/responses"] {
        if let Some(stripped) = path.strip_suffix(endpoint) {
            path = stripped.to_string();
            break;
        }
    }
    if path.is_empty() {
        path = "/v1".to_string();
    }
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Checks a user-chosen provider id.
pub fn validate_provider_id(id: &str) -> Result<(), SelfHostedError> {
    let valid_chars = id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    let starts_well = id
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if id.is_empty() || id.len() > MAX_ID_LEN || !valid_chars || !starts_well {
        return Err(SelfHostedError::InvalidName(format!(
            "\"{id}\": use 1-{MAX_ID_LEN} lower-case letters, digits, '-' or '_'"
        )));
    }
    if RESERVED_IDS.contains(&id) {
        return Err(SelfHostedError::InvalidName(format!(
            "\"{id}\" is a built-in provider; choose another name"
        )));
    }
    Ok(())
}

/// The provider id for a preset when the user names none: the preset's
/// default, made unique among `existing` as [`default_provider_id`] does.
pub fn default_preset_provider_id(
    preset: &ApiPreset,
    base_url: &str,
    existing: &[SelfHostedProvider],
) -> String {
    unique_provider_id(preset.default_id.to_string(), base_url, existing)
}

/// A provider id for `base_url` when the user names none: the host's first
/// label (`local` for loopback), made unique among `existing` unless the
/// server there already has the same URL (then it is replaced).
pub fn default_provider_id(base_url: &str, existing: &[SelfHostedProvider]) -> String {
    let host = url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default();
    let is_loopback = host == "localhost"
        || host
            .trim_matches(|c| c == '[' || c == ']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    let label = if is_loopback {
        "local".to_string()
    } else if host.parse::<std::net::IpAddr>().is_ok() {
        format!("server-{}", host.replace(['.', ':'], "-"))
    } else {
        host.split('.').next().unwrap_or_default().to_string()
    };
    let mut base: String = label
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    base.truncate(MAX_ID_LEN - 3);
    let base = base.trim_matches(|c| c == '-' || c == '_').to_string();
    let base = if base.is_empty() || validate_provider_id(&base).is_err() {
        "self-hosted".to_string()
    } else {
        base
    };
    unique_provider_id(base, base_url, existing)
}

/// `base`, or `base-2`, `base-3`, … when a provider of another URL has it.
fn unique_provider_id(base: String, base_url: &str, existing: &[SelfHostedProvider]) -> String {
    let free = |id: &str| {
        existing
            .iter()
            .all(|p| p.id != id || p.base_url == base_url)
    };
    if free(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|id| free(id))
        .unwrap_or(base)
}

/// Why a server could not be added.
#[derive(Debug)]
pub enum SelfHostedError {
    InvalidUrl(String),
    InvalidName(String),
    /// Nothing answered at the URL (refused, DNS, timeout, TLS).
    Unreachable {
        url: String,
        reason: String,
    },
    /// The server wants a (different) API key.
    Unauthorized {
        url: String,
        status: u16,
    },
    /// The server answered something other than a model list.
    BadResponse {
        url: String,
        reason: String,
    },
    /// The server lists no models and none were given.
    NoModels {
        url: String,
    },
    /// The filter left none of the listed models.
    NoMatchingModels {
        filter: String,
        found: usize,
    },
    /// `--api <name>` names neither a preset nor a URL.
    UnknownPreset(String),
    /// A cloud API was given no key.
    KeyRequired {
        label: String,
    },
    Io(io::Error),
}

impl fmt::Display for SelfHostedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(reason) => write!(f, "invalid server URL: {reason}"),
            Self::InvalidName(reason) => write!(f, "invalid name {reason}"),
            Self::Unreachable { url, reason } => write!(
                f,
                "could not reach {url}: {reason}. Check that the server is running and the URL is right (it usually ends in /v1)."
            ),
            Self::Unauthorized { url, status } => write!(
                f,
                "{url} refused the request (HTTP {status}): the server needs an API key, or a different one."
            ),
            Self::BadResponse { url, reason } => write!(
                f,
                "{url} did not answer like an OpenAI-compatible server: {reason}"
            ),
            Self::NoModels { url } => write!(
                f,
                "{url} lists no models. Load or pull a model on the server, or name one with --model."
            ),
            Self::NoMatchingModels { filter, found } => write!(
                f,
                "none of the {found} models matches \"{filter}\"; try another filter"
            ),
            Self::UnknownPreset(name) => write!(
                f,
                "unknown API \"{name}\": use one of {} or a URL",
                API_PRESETS
                    .iter()
                    .map(|preset| preset.kind)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Self::KeyRequired { label } => write!(
                f,
                "{label} needs an API key: pipe it to --with-api-key, or name its variable with --api-key-env."
            ),
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for SelfHostedError {}

impl From<io::Error> for SelfHostedError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

/// What `GET /models` said about one model.
#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredModel {
    pub id: String,
    pub context_window: Option<i64>,
    /// The listing says it takes images (OpenRouter's
    /// `architecture.input_modalities`).
    pub vision: bool,
}

/// The model list of an OpenAI-style `/models` body. Servers that report a
/// context length (vLLM's `max_model_len`, llama.cpp's `meta.n_ctx_train`,
/// LM Studio's `max_context_length`, OpenRouter's `context_length`) have it
/// kept, and listings that declare input modalities (OpenRouter) say which
/// models take images.
pub fn parse_models_response(body: &serde_json::Value) -> Option<Vec<DiscoveredModel>> {
    let entries = body
        .get("data")
        .or_else(|| body.get("models"))
        .and_then(serde_json::Value::as_array)?;
    let context_of = |entry: &serde_json::Value| {
        [
            "max_model_len",
            "context_length",
            "context_window",
            "max_context_length",
        ]
        .iter()
        .find_map(|key| entry.get(*key).and_then(serde_json::Value::as_i64))
        .or_else(|| {
            entry
                .get("meta")
                .and_then(|meta| meta.get("n_ctx_train"))
                .and_then(serde_json::Value::as_i64)
        })
        .filter(|window| *window > 0)
    };
    let vision_of = |entry: &serde_json::Value| {
        entry
            .get("architecture")
            .and_then(|arch| arch.get("input_modalities"))
            .or_else(|| entry.get("input_modalities"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|modalities| modalities.iter().any(|m| m.as_str() == Some("image")))
    };
    Some(
        entries
            .iter()
            .filter_map(|entry| {
                let id = entry
                    .get("id")
                    .or_else(|| entry.get("name"))
                    .or_else(|| entry.get("model"))
                    .and_then(serde_json::Value::as_str)?;
                Some(DiscoveredModel {
                    id: id.to_string(),
                    context_window: context_of(entry),
                    vision: vision_of(entry),
                })
            })
            .collect(),
    )
}

/// Lists the models `base_url` serves (`GET {base_url}/models`).
pub async fn probe_models(
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<DiscoveredModel>, SelfHostedError> {
    let url = format!("{base_url}/models");
    let client = create_client();
    let mut request = client
        .get(&url)
        .header("Accept", "application/json")
        .timeout(PROBE_TIMEOUT);
    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let response = request
        .send()
        .await
        .map_err(|err| SelfHostedError::Unreachable {
            url: url.clone(),
            reason: err.to_string(),
        })?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(SelfHostedError::Unauthorized {
            url,
            status: status.as_u16(),
        });
    }
    if !status.is_success() {
        // Gemini answers a bad key with 400 "Please pass a valid API key".
        let body = response.text().await.unwrap_or_default();
        if status.as_u16() == 400 && body.to_ascii_lowercase().contains("api key") {
            return Err(SelfHostedError::Unauthorized {
                url,
                status: status.as_u16(),
            });
        }
        return Err(SelfHostedError::BadResponse {
            url,
            reason: format!("HTTP {status}"),
        });
    }
    let text = response
        .text()
        .await
        .map_err(|err| SelfHostedError::BadResponse {
            url: url.clone(),
            reason: err.to_string(),
        })?;
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| SelfHostedError::BadResponse {
            url: url.clone(),
            reason: "the answer is not JSON".to_string(),
        })?;
    parse_models_response(&body).ok_or_else(|| SelfHostedError::BadResponse {
        url,
        reason: "no `data` list in the answer".to_string(),
    })
}

/// A model API to add, as the CLI or onboarding collected it.
#[derive(Default)]
pub struct SelfHostedRequest {
    /// The base URL; may be empty when `kind` is a preset (its URL is used).
    pub base_url: String,
    /// The preset (`"openrouter"`, an alias, or [`CUSTOM_KIND`]); a custom
    /// server when absent.
    pub kind: Option<String>,
    /// The provider id; from the preset, else from the host, when absent.
    pub name: Option<String>,
    pub api_key: Option<String>,
    pub api_key_env: Option<String>,
    /// Models to use instead of the discovered list.
    pub models: Vec<String>,
    /// Keep only discovered models matching this (see [`model_matches_filter`]).
    pub model_filter: Option<String>,
    /// Context window for every model (overrides what the server reports).
    pub context_window: Option<i64>,
    /// Mark every model as accepting images.
    pub vision: bool,
}

/// What `GET /models` of a requested API answered.
#[derive(Debug, Clone)]
pub struct ProbedApi {
    pub base_url: String,
    /// The chat models listed, in the server's order (empty when the
    /// server lists none and models were given by hand).
    pub discovered: Vec<DiscoveredModel>,
}

/// A model API just saved.
#[derive(Debug, Clone)]
pub struct AddedApi {
    pub provider: SelfHostedProvider,
    /// How many chat models the server listed (before filter and cap).
    pub found: usize,
}

fn request_preset(
    request: &SelfHostedRequest,
) -> Result<Option<&'static ApiPreset>, SelfHostedError> {
    match request.kind.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(kind) if kind.eq_ignore_ascii_case(CUSTOM_KIND) => Ok(None),
        Some(kind) => api_preset(kind)
            .map(Some)
            .ok_or_else(|| SelfHostedError::UnknownPreset(kind.to_string())),
    }
}

fn request_base_url(
    request: &SelfHostedRequest,
    preset: Option<&ApiPreset>,
) -> Result<String, SelfHostedError> {
    match preset {
        Some(preset) if request.base_url.trim().is_empty() => Ok(preset.base_url.to_string()),
        _ => normalize_base_url(&request.base_url),
    }
}

fn trimmed(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Asks the API for its models (with the key, if one is given), keeping the
/// chat models. A preset that needs a key fails here without one.
pub async fn probe_api(request: &SelfHostedRequest) -> Result<ProbedApi, SelfHostedError> {
    let preset = request_preset(request)?;
    let base_url = request_base_url(request, preset)?;
    let api_key = trimmed(&request.api_key);
    let api_key_env = trimmed(&request.api_key_env);
    if let Some(preset) = preset
        && preset.key_required
        && api_key.is_none()
        && api_key_env.is_none()
    {
        return Err(SelfHostedError::KeyRequired {
            label: preset.label.to_string(),
        });
    }
    let key_for_probe = api_key.or_else(|| {
        api_key_env
            .as_deref()
            .and_then(|var| std::env::var(var).ok())
    });
    let discovered = match probe_models(&base_url, key_for_probe.as_deref()).await {
        Ok(models) => models
            .into_iter()
            .filter(|model| is_chat_model_id(&model.id))
            .collect(),
        // A server that cannot list models can still be used by name.
        Err(SelfHostedError::BadResponse { .. }) if !request.models.is_empty() => Vec::new(),
        Err(err) => return Err(err),
    };
    Ok(ProbedApi {
        base_url,
        discovered,
    })
}

/// Saves the API `probe` found: the models given by hand, else the
/// discovered ones matching the filter, at most [`MAX_STORED_MODELS`].
pub fn save_probed_api(
    codex_home: &Path,
    request: &SelfHostedRequest,
    probe: ProbedApi,
) -> Result<AddedApi, SelfHostedError> {
    let preset = request_preset(request)?;
    let ProbedApi {
        base_url,
        discovered,
    } = probe;
    let existing = read_self_hosted_providers(codex_home)?;
    let id = match trimmed(&request.name) {
        Some(name) => {
            validate_provider_id(&name)?;
            name
        }
        None => match preset {
            Some(preset) => default_preset_provider_id(preset, &base_url, &existing),
            None => default_provider_id(&base_url, &existing),
        },
    };
    let found = discovered.len();
    let manual_models = !request.models.is_empty();
    let models: Vec<SelfHostedModel> = if manual_models {
        request
            .models
            .iter()
            .map(|id| id.trim())
            .filter(|id| !id.is_empty())
            .map(|id| {
                let listed = discovered.iter().find(|d| d.id == id);
                SelfHostedModel {
                    id: id.to_string(),
                    context_window: listed.and_then(|d| d.context_window),
                    vision: listed.is_some_and(|d| d.vision),
                }
            })
            .collect()
    } else {
        let filter = trimmed(&request.model_filter).unwrap_or_default();
        let matching: Vec<SelfHostedModel> = discovered
            .into_iter()
            .filter(|d| model_matches_filter(&d.id, &filter))
            .take(MAX_STORED_MODELS)
            .map(|d| SelfHostedModel {
                id: d.id,
                context_window: d.context_window,
                vision: d.vision,
            })
            .collect();
        if matching.is_empty() && found > 0 {
            return Err(SelfHostedError::NoMatchingModels { filter, found });
        }
        matching
    };
    if models.is_empty() {
        return Err(SelfHostedError::NoModels {
            url: format!("{base_url}/models"),
        });
    }
    let models = models
        .into_iter()
        .map(|model| SelfHostedModel {
            context_window: request
                .context_window
                .filter(|window| *window > 0)
                .or(model.context_window),
            vision: request.vision || model.vision,
            ..model
        })
        .collect();
    let kind = match preset {
        Some(preset) => Some(preset.kind.to_string()),
        None if request.kind.is_some() => Some(CUSTOM_KIND.to_string()),
        None => None,
    };
    let provider = SelfHostedProvider {
        id,
        kind,
        name: None,
        base_url,
        api_key: trimmed(&request.api_key),
        api_key_env: trimmed(&request.api_key_env),
        models,
        manual_models,
    };
    upsert_self_hosted_provider(codex_home, provider.clone())?;
    Ok(AddedApi { provider, found })
}

/// Probes the API, then saves it (see [`probe_api`], [`save_probed_api`]).
pub async fn add_api_provider(
    codex_home: &Path,
    request: SelfHostedRequest,
) -> Result<AddedApi, SelfHostedError> {
    let probe = probe_api(&request).await?;
    save_probed_api(codex_home, &request, probe)
}

/// Probes the server, then saves it. The server must answer `/models` (with
/// the key, if one is given); manual models replace the discovered list.
pub async fn add_self_hosted_provider(
    codex_home: &Path,
    request: SelfHostedRequest,
) -> Result<SelfHostedProvider, SelfHostedError> {
    add_api_provider(codex_home, request)
        .await
        .map(|added| added.provider)
}

#[cfg(test)]
#[path = "unieai_self_hosted_tests.rs"]
mod tests;
