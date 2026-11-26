// Copyright (c) 2026 UnieAI. All rights reserved.

//! Test helpers for upstream tests that assume upstream defaults.
//!
//! UnieAI defaults `model_provider` to `unieai`, which has no bundled model
//! catalog and no ChatGPT account routing. Upstream tests that start threads
//! or exercise ChatGPT routing pin the provider upstream uses by default.

use std::path::Path;

/// The `config.toml` text with `model_provider = "openai"` in front, unless
/// it already names a provider. Top-level keys must precede table headers.
pub(crate) fn with_openai_provider(config_toml: &str) -> String {
    if config_toml
        .lines()
        .any(|line| line.trim_start().starts_with("model_provider"))
    {
        return config_toml.to_string();
    }
    format!("model_provider = \"openai\"\n{config_toml}")
}

/// Pin `model_provider = "openai"` in `codex_home/config.toml`.
pub(crate) fn pin_openai_provider(codex_home: &Path) {
    let path = codex_home.join(codex_config::CONFIG_TOML_FILE);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(path, with_openai_provider(&existing)).expect("write test config.toml");
}
