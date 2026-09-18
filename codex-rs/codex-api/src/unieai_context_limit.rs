// Copyright (c) 2026 UnieAI. All rights reserved.
//! The context window a gateway stated while rejecting a request.
//!
//! The rejection names the model's real limit, but it arrives deep in the SSE
//! parser, which knows neither the model slug nor `CODEX_HOME`. The parser
//! leaves the number here; the session layer, which knows both, picks it up
//! and records it (see `codex_models_manager::unieai_context_limits`).

use std::sync::Mutex;
use std::sync::OnceLock;

fn cell() -> &'static Mutex<Option<i64>> {
    static LIMIT: OnceLock<Mutex<Option<i64>>> = OnceLock::new();
    LIMIT.get_or_init(|| Mutex::new(None))
}

/// Remember the limit a gateway just stated, replacing any older one.
pub fn note(limit: i64) {
    if let Ok(mut slot) = cell().lock() {
        *slot = Some(limit);
    }
}

/// Take the stated limit, if a rejection recorded one since the last take.
pub fn take() -> Option<i64> {
    cell().lock().ok().and_then(|mut slot| slot.take())
}
