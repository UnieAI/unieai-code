// Copyright (c) 2026 UnieAI. All rights reserved.
//! Context windows for UnieAI gateway models that declare none.
//!
//! A gateway model's context window reaches the CLI through `unieai.json`
//! (Studio's provider config, its model registry, then the gateway's
//! `/models`). A deployment that records none anywhere leaves the CLI with
//! the fallback metadata's 272k window, so nothing compacts until the
//! gateway rejects the request — which ends the turn.
//!
//! Two safety nets, both here:
//!   * [`UNIEAI_FALLBACK_CONTEXT_WINDOW`], a conservative window for a
//!     gateway model that declares none (most served models are 128k);
//!   * a learned window: the gateway's rejection states the real limit
//!     ("the model's context length (131072 tokens)"), so
//!     [`parse_context_limit`] reads it and [`record`] keeps it in
//!     `$CODEX_HOME/unieai-model-limits.json` for later sessions.
//!
//! A learned window never overrides one the account declares.

pub use codex_protocol::unieai_context_limit::parse_context_limit;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;

/// What a gateway model is assumed to hold when nothing declares its window.
pub const UNIEAI_FALLBACK_CONTEXT_WINDOW: i64 = 128_000;

const LIMITS_FILE: &str = "unieai-model-limits.json";
/// Below this a "limit" is a parse accident, not a context window.
const MIN_PLAUSIBLE_LIMIT: i64 = codex_protocol::unieai_context_limit::MIN_PLAUSIBLE_LIMIT;

pub fn limits_path(codex_home: &Path) -> PathBuf {
    codex_home.join(LIMITS_FILE)
}

/// Windows learned from earlier rejections, by model id.
pub fn load(codex_home: &Path) -> HashMap<String, i64> {
    std::fs::read_to_string(limits_path(codex_home))
        .ok()
        .and_then(|text| serde_json::from_str::<HashMap<String, i64>>(&text).ok())
        .unwrap_or_default()
}

/// Remember `limit` for `model`, keeping the smallest seen (a rejection
/// proves an upper bound, and two deployments of one slug may differ).
pub fn record(codex_home: &Path, model: &str, limit: i64) -> std::io::Result<()> {
    if limit < MIN_PLAUSIBLE_LIMIT || model.is_empty() {
        return Ok(());
    }
    let mut limits = load(codex_home);
    match limits.get(model) {
        Some(known) if *known <= limit => return Ok(()),
        _ => {}
    }
    limits.insert(model.to_string(), limit);
    std::fs::create_dir_all(codex_home)?;
    let json = serde_json::to_string_pretty(&limits).map_err(std::io::Error::other)?;
    std::fs::write(limits_path(codex_home), format!("{json}\n"))
}

/// The context window a gateway model should use: what it declares, else what
/// an earlier rejection taught us, else the conservative fallback.
pub fn resolve_context_window(
    declared: Option<i64>,
    learned: &HashMap<String, i64>,
    model: &str,
) -> Option<i64> {
    declared
        .filter(|window| *window > 0)
        .or_else(|| learned.get(model).copied())
        .or(Some(UNIEAI_FALLBACK_CONTEXT_WINDOW))
}

#[cfg(test)]
#[path = "unieai_context_limits_tests.rs"]
mod tests;
