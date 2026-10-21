// Copyright (c) 2026 UnieAI. All rights reserved.
//! `unieai login --api <PRESET|URL>` (alias `--self-hosted`) and
//! `unieai login api list|remove` (alias `self-hosted`): connected model
//! APIs, a preset provider or any OpenAI-compatible server (see
//! `codex_login::unieai_self_hosted`). Keys are read from stdin or named by
//! environment variable, never taken on the command line, and never printed.

use codex_login::unieai_self_hosted::AddedApi;
use codex_login::unieai_self_hosted::SelfHostedProvider;
use codex_login::unieai_self_hosted::SelfHostedRequest;
use codex_utils_cli::CliConfigOverrides;

use crate::login::load_config_or_exit;
use crate::login::read_stdin_secret;

/// What `unieai login --api` was given.
pub struct SelfHostedLoginArgs {
    /// A preset name (`openrouter`) or a URL.
    pub target: String,
    pub name: Option<String>,
    pub api_key_env: Option<String>,
    /// `--with-api-key`: read the key from stdin.
    pub key_from_stdin: bool,
    pub models: Vec<String>,
    pub context_window: Option<i64>,
    pub vision: bool,
}

/// `--api <target>` as a request: a preset by name, else a custom URL. A
/// bare word that is no preset (`--api openroute`) is refused as an unknown
/// preset rather than tried as the host `http://openroute/v1`.
pub fn api_request(target: &str) -> SelfHostedRequest {
    let trimmed = target.trim();
    let looks_like_url = trimmed.contains(['.', ':', '/']) || trimmed == "localhost";
    match codex_login::unieai_self_hosted::api_preset(trimmed) {
        Some(preset) => SelfHostedRequest {
            kind: Some(preset.kind.to_string()),
            ..Default::default()
        },
        None if !looks_like_url => SelfHostedRequest {
            kind: Some(trimmed.to_string()),
            ..Default::default()
        },
        None => SelfHostedRequest {
            base_url: trimmed.to_string(),
            ..Default::default()
        },
    }
}

pub fn read_self_hosted_key_from_stdin() -> String {
    read_stdin_secret(
        "--with-api-key expects the API key on stdin. Try piping it, e.g. `printenv OPENROUTER_API_KEY | unieai login --api openrouter --with-api-key`.",
        "Reading API key from stdin...",
        "No API key provided via stdin.",
    )
}

/// One line per model: its slug and what is known about it.
fn describe_models(server: &SelfHostedProvider) -> Vec<String> {
    server
        .models
        .iter()
        .map(|model| {
            let mut notes = Vec::new();
            if let Some(window) = model.context_window {
                notes.push(format!("{window} tokens"));
            }
            if model.vision {
                notes.push("vision".to_string());
            }
            let notes = if notes.is_empty() {
                String::new()
            } else {
                format!(" ({})", notes.join(", "))
            };
            format!("  {}{notes}", server.slug(&model.id))
        })
        .collect()
}

/// What the CLI prints after adding an API (to stderr).
pub fn added_api_lines(added: &AddedApi) -> Vec<String> {
    let server = &added.provider;
    let what = match server.preset() {
        Some(preset) => format!("{} as \"{}\"", preset.label, server.id),
        None => format!("self-hosted server \"{}\"", server.id),
    };
    let mut lines = vec![format!(
        "Connected {what} ({}, {}).",
        server.base_url,
        server.key_source()
    )];
    let source = if server.manual_models {
        " (given with --model)".to_string()
    } else if added.found > server.models.len() {
        format!(
            " (the first {} of {} listed; pin others with --model)",
            server.models.len(),
            added.found
        )
    } else {
        String::new()
    };
    lines.push(format!("{} model(s){source}:", server.models.len()));
    lines.extend(describe_models(server));
    let first = server
        .models
        .first()
        .map(|model| model.id.as_str())
        .unwrap_or_default();
    lines.push(format!(
        "Pick one with /model in the TUI, or set `model = \"{}\"` in config.toml.",
        server.slug(first)
    ));
    if server.runs_on_codex_engine() {
        lines.push(format!(
            "Runs on the uac engine; the codex engine can use it too with `model_provider = \"{}\"` and `model = \"{first}\"` in config.toml.",
            server.id
        ));
    } else {
        lines.push(
            "Runs on the uac engine (unieai-agent-core); the codex engine needs the Responses API, which this API does not reliably serve."
                .to_string(),
        );
    }
    lines
}

pub async fn run_login_with_self_hosted(
    cli_config_overrides: CliConfigOverrides,
    args: SelfHostedLoginArgs,
) -> ! {
    let config = load_config_or_exit(cli_config_overrides).await;
    let api_key = args.key_from_stdin.then(read_self_hosted_key_from_stdin);
    if let Some(var) = &args.api_key_env
        && std::env::var(var).is_err()
    {
        eprintln!("Warning: ${var} is not set now; it must be set wherever UnieAI Code runs.");
    }
    let request = SelfHostedRequest {
        name: args.name,
        api_key,
        api_key_env: args.api_key_env,
        models: args.models,
        context_window: args.context_window,
        vision: args.vision,
        ..api_request(&args.target)
    };
    match codex_login::unieai_self_hosted::add_api_provider(&config.codex_home, request).await {
        Ok(added) => {
            for line in added_api_lines(&added) {
                eprintln!("{line}");
            }
            std::process::exit(0);
        }
        Err(err) => {
            eprintln!("Error connecting the model API: {err}");
            std::process::exit(1);
        }
    }
}

pub async fn run_self_hosted_list(cli_config_overrides: CliConfigOverrides) -> ! {
    let config = load_config_or_exit(cli_config_overrides).await;
    let servers =
        match codex_login::unieai_self_hosted::read_self_hosted_providers(&config.codex_home) {
            Ok(servers) => servers,
            Err(err) => {
                eprintln!(
                    "Error reading {}: {err}",
                    codex_login::unieai_self_hosted::self_hosted_path(&config.codex_home).display()
                );
                std::process::exit(1);
            }
        };
    if servers.is_empty() {
        eprintln!("No model APIs connected. Add one with `unieai login --api <PRESET|URL>`.");
        std::process::exit(0);
    }
    for server in &servers {
        println!(
            "{}  {}  {}  ({})",
            server.id,
            server.label(),
            server.base_url,
            server.key_source()
        );
        for line in describe_models(server) {
            println!("{line}");
        }
    }
    std::process::exit(0);
}

pub async fn run_self_hosted_remove(cli_config_overrides: CliConfigOverrides, name: String) -> ! {
    let config = load_config_or_exit(cli_config_overrides).await;
    match codex_login::unieai_self_hosted::remove_self_hosted_provider(&config.codex_home, &name) {
        Ok(true) => {
            eprintln!("Removed model API \"{name}\".");
            std::process::exit(0);
        }
        Ok(false) => {
            eprintln!("No model API is named \"{name}\". See `unieai login api list`.");
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Error removing \"{name}\": {err}");
            std::process::exit(1);
        }
    }
}

/// `unieai login status` lines for the connected APIs.
pub(crate) fn self_hosted_status_lines(codex_home: &std::path::Path) -> Vec<String> {
    codex_login::unieai_self_hosted::load_self_hosted_providers(codex_home)
        .iter()
        .map(|server| {
            format!(
                "Model API \"{}\" ({}): {} ({} model(s), {})",
                server.id,
                server.label(),
                server.base_url,
                server.models.len(),
                server.key_source()
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_login::unieai_self_hosted::SelfHostedModel;
    use pretty_assertions::assert_eq;

    #[test]
    fn api_targets_are_presets_or_urls() {
        let preset = api_request("OpenRouter");
        assert_eq!(preset.kind.as_deref(), Some("openrouter"));
        assert_eq!(preset.base_url, "");
        let url = api_request("http://gpu-box:8000/v1");
        assert_eq!(url.kind, None);
        assert_eq!(url.base_url, "http://gpu-box:8000/v1");
        assert_eq!(api_request("localhost").base_url, "localhost");
        assert_eq!(api_request("127.0.0.1:8000").base_url, "127.0.0.1:8000");
        // A bare word is a (mistyped) preset, not a host.
        let typo = api_request("openroute");
        assert_eq!(
            (typo.kind.as_deref(), typo.base_url.as_str()),
            (Some("openroute"), "")
        );
    }

    #[test]
    fn a_custom_server_is_announced_as_self_hosted() {
        let mut custom = added("custom", "gpu", 1, 1);
        custom.provider.kind = None;
        let lines = added_api_lines(&custom).join("\n");
        assert!(
            lines.starts_with("Connected self-hosted server \"gpu\""),
            "{lines}"
        );
    }

    fn added(kind: &str, id: &str, models: usize, found: usize) -> AddedApi {
        AddedApi {
            provider: SelfHostedProvider {
                id: id.to_string(),
                kind: Some(kind.to_string()),
                name: None,
                base_url: "https://example.test/v1".to_string(),
                api_key: Some("sk-never-printed".to_string()),
                api_key_env: None,
                models: (0..models)
                    .map(|n| SelfHostedModel {
                        id: format!("m{n}"),
                        context_window: None,
                        vision: false,
                    })
                    .collect(),
                manual_models: false,
            },
            found,
        }
    }

    #[test]
    fn added_lines_name_the_preset_cap_and_engines() {
        let lines = added_api_lines(&added("openrouter", "openrouter", 2, 468)).join("\n");
        assert!(
            lines.starts_with("Connected OpenRouter as \"openrouter\""),
            "{lines}"
        );
        assert!(lines.contains("the first 2 of 468 listed"), "{lines}");
        assert!(lines.contains("openrouter/m0"), "{lines}");
        assert!(
            lines.contains("Runs on the uac engine (unieai-agent-core)"),
            "{lines}"
        );
        assert!(!lines.contains("sk-never-printed"), "{lines}");

        let lines = added_api_lines(&added("openai", "openai-api", 1, 1)).join("\n");
        assert!(
            lines.starts_with("Connected OpenAI as \"openai-api\""),
            "{lines}"
        );
        assert!(lines.contains("model_provider = \"openai-api\""), "{lines}");
        assert!(!lines.contains("listed;"), "{lines}");
    }
}
