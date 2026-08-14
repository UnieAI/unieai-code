//! The skeptic's one model call.
//!
//! Deliberately chat-completions rather than the Responses wire: this is a
//! one-shot judgement with no tools and no streaming, and every gateway that
//! serves codex also serves this. Deliberately blocking and dependency-light —
//! the hook is a short-lived process with one request to make.

use std::io::Write;

const DEFAULT_BASE_URL: &str = "https://api.unieai.com/v1";
const DEFAULT_TIMEOUT_SECS: u64 = 60;

fn api_key() -> Option<String> {
    for var in ["UNIEAI_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn base_url() -> String {
    std::env::var("UNIEAI_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Ask the reviewer. `None` means the call could not be made or produced
/// nothing — which the contract treats as "no objection", never as a refusal.
pub fn call(model: &str, system: &str, user: &str) -> Option<String> {
    let key = api_key()?;
    if model.trim().is_empty() {
        return None;
    }
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user },
        ],
        "temperature": 0,
        "max_tokens": 600,
        "stream": false,
        // This is a one-line verdict, not a problem to think through. A thinking
        // model spends the whole budget on `reasoning_content` and returns
        // `content: null` — which reads as an empty verdict, which reads as
        // "no gaps". That silently turned the skeptic into a no-op for an entire
        // benchmark run before it was noticed.
        "chat_template_kwargs": { "enable_thinking": false },
    })
    .to_string();

    let raw = post_json(&format!("{}/chat/completions", base_url()), &key, &body)?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let message = value.get("choices")?.get(0)?.get("message")?;
    // Belt and braces: if a provider ignores the flag above and answers with
    // thinking only, the verdict is in `reasoning_content`. An empty verdict is
    // indistinguishable from "found nothing", so it must never be the result of
    // a field name we failed to read.
    for field in ["content", "reasoning_content"] {
        if let Some(text) = message.get(field).and_then(|c| c.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// A minimal HTTPS POST.
///
/// The hook must not drag a TLS stack and an async runtime into a process whose
/// whole job is one request, so this shells out to `curl`, which is present
/// wherever codex's own sandbox and git already are. Failure of any kind returns
/// `None` and the turn is allowed to end.
fn post_json(url: &str, key: &str, body: &str) -> Option<String> {
    let timeout = std::env::var("UNIEAI_HOOK_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let out = std::process::Command::new("curl")
        .args([
            "-s",
            "--max-time",
            &timeout.to_string(),
            "-H",
            "content-type: application/json",
            "-H",
            &format!("authorization: Bearer {key}"),
            "-X",
            "POST",
            "--data-binary",
            "@-",
            url,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
        .and_then(|mut child| {
            child.stdin.take()?.write_all(body.as_bytes()).ok()?;
            child.wait_with_output().ok()
        })?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    if text.trim().is_empty() { None } else { Some(text) }
}
