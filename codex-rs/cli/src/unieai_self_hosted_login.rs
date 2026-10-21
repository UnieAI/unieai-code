// Copyright (c) 2026 UnieAI. All rights reserved.
//! `unieai login --self-hosted <URL>` and `unieai login self-hosted
//! list|remove`: self-hosted model servers (see
//! `codex_login::unieai_self_hosted`). Keys are read from stdin or named by
//! environment variable, never taken on the command line, and never printed.

use codex_login::unieai_self_hosted::SelfHostedProvider;
use codex_login::unieai_self_hosted::SelfHostedRequest;
use codex_utils_cli::CliConfigOverrides;

use crate::login::load_config_or_exit;
use crate::login::read_stdin_secret;

/// What `unieai login --self-hosted` was given.
pub struct SelfHostedLoginArgs {
    pub base_url: String,
    pub name: Option<String>,
    pub api_key_env: Option<String>,
    /// `--with-api-key`: read the key from stdin.
    pub key_from_stdin: bool,
    pub models: Vec<String>,
    pub context_window: Option<i64>,
    pub vision: bool,
}

pub fn read_self_hosted_key_from_stdin() -> String {
    read_stdin_secret(
        "--with-api-key expects the server's API key on stdin. Try piping it, e.g. `printenv VLLM_API_KEY | unieai login --self-hosted http://gpu-box:8000/v1 --with-api-key`.",
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
        base_url: args.base_url,
        name: args.name,
        api_key,
        api_key_env: args.api_key_env,
        models: args.models,
        context_window: args.context_window,
        vision: args.vision,
    };
    match codex_login::unieai_self_hosted::add_self_hosted_provider(&config.codex_home, request)
        .await
    {
        Ok(server) => {
            eprintln!(
                "Added self-hosted model server \"{}\" ({}, {}).",
                server.id,
                server.base_url,
                server.key_source()
            );
            eprintln!(
                "{} model(s){}:",
                server.models.len(),
                if server.manual_models {
                    " (given with --model)"
                } else {
                    ""
                }
            );
            for line in describe_models(&server) {
                eprintln!("{line}");
            }
            eprintln!(
                "Pick one with /model in the TUI, or set `model = \"{}\"` in config.toml.",
                server
                    .models
                    .first()
                    .map(|model| server.slug(&model.id))
                    .unwrap_or_default()
            );
            eprintln!(
                "Self-hosted models run on the uac engine (unieai-agent-core); the codex engine needs the Responses API, which these servers do not reliably serve."
            );
            std::process::exit(0);
        }
        Err(err) => {
            eprintln!("Error adding the self-hosted model server: {err}");
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
        eprintln!("No self-hosted model servers. Add one with `unieai login --self-hosted <URL>`.");
        std::process::exit(0);
    }
    for server in &servers {
        println!(
            "{}  {}  ({})",
            server.id,
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
            eprintln!("Removed self-hosted model server \"{name}\".");
            std::process::exit(0);
        }
        Ok(false) => {
            eprintln!(
                "No self-hosted model server is named \"{name}\". See `unieai login self-hosted list`."
            );
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("Error removing \"{name}\": {err}");
            std::process::exit(1);
        }
    }
}

/// `unieai login status` lines for the configured servers.
pub(crate) fn self_hosted_status_lines(codex_home: &std::path::Path) -> Vec<String> {
    codex_login::unieai_self_hosted::load_self_hosted_providers(codex_home)
        .iter()
        .map(|server| {
            format!(
                "Self-hosted model server \"{}\": {} ({} model(s), {})",
                server.id,
                server.base_url,
                server.models.len(),
                server.key_source()
            )
        })
        .collect()
}
