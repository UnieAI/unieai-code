// Copyright (c) 2026 UnieAI. All rights reserved.
//! Remember the context window a gateway stated while rejecting a turn.
//!
//! The SSE parser reads the limit out of the rejection but knows neither the
//! model nor `CODEX_HOME` (see `codex_api::unieai_context_limit`). The turn
//! does, so it records the limit here; the next session sizes the model's
//! window from it instead of the fallback metadata's.

use crate::session::turn_context::TurnContext;

/// Record the limit a rejection just stated, if it stated one.
pub(crate) fn note_gateway_context_limit(turn_context: &TurnContext) {
    let Some(limit) = codex_api::unieai_context_limit::take() else {
        return;
    };
    let model = turn_context.model_info().slug.clone();
    let codex_home = turn_context.config.codex_home.as_path();
    match codex_models_manager::unieai_context_limits::record(codex_home, &model, limit) {
        Ok(()) => tracing::info!(
            model = %model,
            limit,
            "gateway stated this model's context window; remembered for later sessions"
        ),
        Err(err) => tracing::warn!(%err, "could not record the gateway's context window"),
    }
}
