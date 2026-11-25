// Copyright (c) 2026 UnieAI. All rights reserved.
//! `/mcp callback <url>`: finish an MCP sign-in whose browser redirect never
//! reached this machine.
//!
//! The OAuth listener runs on the machine the app-server runs on, and the
//! authorization server redirects the *browser* to it (`http://127.0.0.1:<port>/
//! callback?code=…&state=…`). When the browser is on another computer (SSH,
//! a remote dev box), that redirect lands on the other computer's loopback and
//! the user sees a connection error instead of a callback page. The URL in the
//! address bar still carries the code, so this delivers it to the listener on
//! the user's behalf: the same request the browser would have made. The flow
//! behind the listener then checks state and issuer and exchanges the code
//! exactly as before.
//!
//! The pasted URL is only sent when it names this login's loopback redirect
//! and carries this login's `state`, so it cannot be used to reach anything
//! else on the machine or to feed a different login.

use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use url::Url;

/// Why a pasted URL was not delivered, worded for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallbackRejected(pub(crate) String);

fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(host, Some("127.0.0.1" | "localhost" | "[::1]" | "::1"))
}

/// The loopback URL to request for `pasted`, when it is the redirect of the
/// sign-in that `authorization_url` started.
pub(crate) fn callback_target(
    authorization_url: &str,
    pasted: &str,
) -> Result<Url, CallbackRejected> {
    let reject = |message: &str| Err(CallbackRejected(message.to_string()));
    let pasted = pasted.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    let Ok(callback) = Url::parse(pasted) else {
        return reject("That is not a URL. Copy the whole address from the browser's address bar.");
    };
    let Ok(authorization) = Url::parse(authorization_url) else {
        return reject("This sign-in's authorization URL could not be read; run `/mcp login <name>` again.");
    };
    let Some(redirect) = query_param(&authorization, "redirect_uri").and_then(|uri| Url::parse(&uri).ok())
    else {
        return reject("This sign-in did not use a local callback, so there is nothing to paste; finish it in the browser.");
    };
    if !is_loopback(redirect.host_str()) {
        return reject("This sign-in's callback is not on this machine; finish it in the browser.");
    }
    if callback.scheme() != "http"
        || !is_loopback(callback.host_str())
        || callback.port_or_known_default() != redirect.port_or_known_default()
        || callback.path() != redirect.path()
    {
        return reject(&format!(
            "That is not this sign-in's redirect. It should start with {}",
            redirect.as_str().split('?').next().unwrap_or_default()
        ));
    }
    let expected_state = query_param(&authorization, "state");
    if expected_state.is_none() || query_param(&callback, "state") != expected_state {
        return reject("That redirect belongs to a different sign-in attempt (its state does not match). Use the URL from the most recent `/mcp login`.");
    }
    if query_param(&callback, "code").is_none() && query_param(&callback, "error").is_none() {
        return reject("That redirect has no code yet. Approve access in the browser first, then copy the address it lands on.");
    }
    let mut target = redirect;
    target.set_query(callback.query());
    Ok(target)
}

/// Sends `target` to the local listener, as the browser would have, and
/// returns the HTTP status it answered with.
pub(crate) async fn deliver(target: &Url) -> Result<u16, String> {
    let host = match target.host_str() {
        Some("localhost") | None => "127.0.0.1",
        Some(host) => host.trim_start_matches('[').trim_end_matches(']'),
    };
    let port = target
        .port_or_known_default()
        .ok_or_else(|| "the callback URL has no port".to_string())?;
    let path = match target.query() {
        Some(query) => format!("{}?{query}", target.path()),
        None => target.path().to_string(),
    };
    let connect = tokio::net::TcpStream::connect((host, port));
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(5), connect)
        .await
        .map_err(|_| "the sign-in listener did not answer".to_string())?
        .map_err(|err| {
            format!("the sign-in is no longer waiting for a callback ({err}); run `/mcp login <name>` again")
        })?;
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|err| format!("could not send the callback: {err}"))?;
    let mut response = Vec::new();
    let read = stream.read_to_end(&mut response);
    tokio::time::timeout(std::time::Duration::from_secs(10), read)
        .await
        .map_err(|_| "the sign-in listener did not answer".to_string())?
        .map_err(|err| format!("could not read the listener's answer: {err}"))?;
    let status_line = String::from_utf8_lossy(&response);
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| "the sign-in listener sent an unreadable answer".to_string())
}

#[cfg(test)]
#[path = "mcp_login_callback_tests.rs"]
mod tests;
