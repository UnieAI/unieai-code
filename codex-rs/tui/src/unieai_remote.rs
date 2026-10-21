// Copyright (c) 2026 UnieAI. All rights reserved.
//! Remote Control on the uac engine: watch, steer, approve and answer this
//! session from a browser or phone.
//!
//! The uac server runs the bridge (agent-runtime's unieai-remote-bridge.mjs);
//! this side asks it to start, shows the pairing link and its QR code, and
//! keeps the status line's "Remote: N viewers" current. The methods are not
//! codex protocol methods, so they go out as raw JSON-RPC on the remote
//! app-server connection the uac engine always is. The protocol is
//! docs/unieai/remote-control-protocol.md.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use codex_app_server_client::AppServerRequestHandle;
use codex_app_server_client::RemoteAppServerClient;
use codex_app_server_client::RemoteAppServerConnectArgs;
use codex_app_server_client::RemoteAppServerEndpoint;
use codex_app_server_protocol::JSONRPCRequest;
use codex_app_server_protocol::RequestId;
use qrcode::Color as QrColor;
use qrcode::EcLevel;
use qrcode::QrCode;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use uuid::Uuid;

pub(crate) const START_METHOD: &str = "unieai/remote/start";
pub(crate) const STATUS_METHOD: &str = "unieai/remote/status";
const STOP_METHOD: &str = "unieai/remote/stop";
const DEVICES_METHOD: &str = "unieai/remote/devices";
const REVOKE_METHOD: &str = "unieai/remote/revoke";

/// How often the status line asks how many browsers are watching.
const VIEWER_POLL_INTERVAL: Duration = Duration::from_secs(5);
/// White modules around the code, as scanners need.
const QUIET_ZONE: usize = 2;

pub(crate) const ONLY_UAC: &str =
    "Remote Control works on the unieai-agent-core (uac) engine only.";

/// The bridge's state, as `unieai/remote/start` and `/status` report it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlInfo {
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub relay_url: Option<String>,
    #[serde(default)]
    pub viewers: usize,
    #[serde(default)]
    pub devices: usize,
    #[serde(default)]
    pub error: Option<String>,
    /// Only from `start`: the pairing link, secrets in its fragment.
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// A paired browser, as `unieai/remote/devices` lists it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub paired_at: Option<String>,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub online: bool,
}

// -1 while Remote Control is off; otherwise how many browsers are watching.
static VIEWERS: AtomicI64 = AtomicI64::new(-1);
static POLLING: AtomicBool = AtomicBool::new(false);

/// What the status line shows for Remote Control, when it is on.
pub(crate) fn status_segment() -> Option<String> {
    let viewers = VIEWERS.load(Ordering::Relaxed);
    (viewers >= 0).then(|| viewers_label(viewers as usize))
}

pub(crate) fn viewers_label(viewers: usize) -> String {
    match viewers {
        1 => "Remote: 1 viewer".to_string(),
        n => format!("Remote: {n} viewers"),
    }
}

/// Record the bridge's state; true when the status line must change.
pub(crate) fn record_status(info: Option<&RemoteControlInfo>) -> bool {
    let next = match info {
        Some(info) if info.running => info.viewers as i64,
        _ => -1,
    };
    VIEWERS.swap(next, Ordering::Relaxed) != next
}

async fn call(
    request_handle: &AppServerRequestHandle,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let AppServerRequestHandle::Remote(handle) = request_handle else {
        return Err(ONLY_UAC.to_string());
    };
    handle
        .request_json_rpc(JSONRPCRequest {
            id: RequestId::String(format!("tui-remote-{}", Uuid::new_v4())),
            method: method.to_string(),
            params: Some(params),
            trace: None,
        })
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.message)
}

/// Ask the uac server to start Remote Control and open a pairing link.
pub(crate) async fn start(
    request_handle: AppServerRequestHandle,
) -> Result<RemoteControlInfo, String> {
    let answer = call(&request_handle, START_METHOD, json!({})).await?;
    serde_json::from_value(answer).map_err(|err| format!("unexpected answer: {err}"))
}

/// Keep the viewer count current until the connection goes. One poller per
/// process; `on_change` runs when the status line must be redrawn.
pub(crate) fn watch_viewers(
    request_handle: AppServerRequestHandle,
    on_change: impl Fn() + Send + 'static,
) {
    if POLLING.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        loop {
            match call(&request_handle, STATUS_METHOD, json!({})).await {
                Ok(answer) => {
                    let info = serde_json::from_value::<RemoteControlInfo>(answer).ok();
                    if record_status(info.as_ref()) {
                        on_change();
                    }
                }
                Err(_) => {
                    // The connection is gone (or this server has no bridge):
                    // the next `/remote-control` starts watching again.
                    if record_status(None) {
                        on_change();
                    }
                    break;
                }
            }
            tokio::time::sleep(VIEWER_POLL_INTERVAL).await;
        }
        POLLING.store(false, Ordering::SeqCst);
    });
}

/// The link as a QR code: two module rows per text row, dark on light
/// whatever the terminal's theme, with a quiet zone.
pub fn qr_rows(link: &str) -> Option<Vec<Vec<(bool, bool)>>> {
    let code = QrCode::with_error_correction_level(link.as_bytes(), EcLevel::L).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    let size = width + 2 * QUIET_ZONE;
    let dark = |x: usize, y: usize| -> bool {
        if x < QUIET_ZONE || y < QUIET_ZONE || x >= width + QUIET_ZONE || y >= width + QUIET_ZONE {
            return false;
        }
        colors[(y - QUIET_ZONE) * width + (x - QUIET_ZONE)] == QrColor::Dark
    };
    Some(
        (0..size)
            .step_by(2)
            .map(|y| (0..size).map(|x| (dark(x, y), dark(x, y + 1))).collect())
            .collect(),
    )
}

/// The QR code as styled lines: each cell an upper half block whose
/// foreground is the top module and background the bottom one.
fn qr_lines(link: &str) -> Vec<Line<'static>> {
    let shade = |dark: bool| if dark { Color::Black } else { Color::White };
    qr_rows(link)
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            let mut spans = vec![Span::raw("  ")];
            spans.extend(row.into_iter().map(|(top, bottom)| {
                Span::styled("▀", Style::new().fg(shade(top)).bg(shade(bottom)))
            }));
            Line::from(spans)
        })
        .collect()
}

/// What `/remote-control` prints into history.
pub(crate) fn remote_control_lines(info: &RemoteControlInfo) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        "/remote-control".magenta(),
        Span::raw("  "),
        Span::raw(viewers_label(info.viewers)).bold(),
        format!(" · {} paired", info.devices).dim(),
    ])];
    let Some(link) = info.link.as_deref() else {
        return lines;
    };
    lines.push(Line::from(
        "  Open this link (or scan the code) on your phone or browser to watch, steer and approve this session:",
    ));
    lines.push(Line::from(vec![
        Span::raw("  "),
        link.to_string().cyan().underlined(),
    ]));
    lines.push(Line::from(""));
    lines.extend(qr_lines(link));
    lines.push(Line::from(""));
    let expires = info
        .expires_at
        .as_deref()
        .map(|at| format!(" (until {at})"))
        .unwrap_or_default();
    lines.push(
        format!(
            "  The link pairs one device, once, for 10 minutes{expires}. Paired devices reconnect without it."
        )
        .dim()
        .into(),
    );
    lines.push(
        "  Traffic is end-to-end encrypted; the relay sees only ciphertext. Manage devices with `unieai remote-control devices`."
            .dim()
            .into(),
    );
    lines
}

/// The uac server's socket as a plain client: for `unieai remote-control`.
pub struct UacRemoteControl {
    client: RemoteAppServerClient,
}

impl UacRemoteControl {
    /// Connect to this machine's uac server, starting it if needed. Fails on
    /// the codex engine, which has no Remote Control.
    pub async fn connect(codex_home: &Path) -> Result<Self, String> {
        if crate::unieai_engine::configured_engine(codex_home)
            != crate::unieai_engine::EngineKind::Uac
        {
            return Err(format!(
                "{ONLY_UAC} Switch with `/engine` in the TUI, then try again."
            ));
        }
        let socket_path = crate::unieai_engine::ensure_uac_server(codex_home)
            .await
            .map_err(|err| err.to_string())?;
        let client = RemoteAppServerClient::connect(RemoteAppServerConnectArgs {
            endpoint: RemoteAppServerEndpoint::UnixSocket { socket_path },
            client_name: "unieai-remote-control".to_string(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            experimental_api: true,
            mcp_server_openai_form_elicitation: false,
            opt_out_notification_methods: Vec::new(),
            channel_capacity: 64,
        })
        .await
        .map_err(|err| err.to_string())?;
        Ok(Self { client })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        call(
            &AppServerRequestHandle::Remote(self.client.request_handle()),
            method,
            params,
        )
        .await
    }

    pub async fn start(&self, relay_url: Option<&str>) -> Result<RemoteControlInfo, String> {
        let params = match relay_url {
            Some(url) => json!({ "relayUrl": url }),
            None => json!({}),
        };
        let answer = self.call(START_METHOD, params).await?;
        serde_json::from_value(answer).map_err(|err| format!("unexpected answer: {err}"))
    }

    pub async fn status(&self) -> Result<RemoteControlInfo, String> {
        let answer = self.call(STATUS_METHOD, json!({})).await?;
        serde_json::from_value(answer).map_err(|err| format!("unexpected answer: {err}"))
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.call(STOP_METHOD, json!({})).await.map(|_| ())
    }

    pub async fn devices(&self) -> Result<Vec<RemoteDevice>, String> {
        #[derive(Deserialize)]
        struct Devices {
            devices: Vec<RemoteDevice>,
        }
        let answer = self.call(DEVICES_METHOD, json!({})).await?;
        serde_json::from_value::<Devices>(answer)
            .map(|list| list.devices)
            .map_err(|err| format!("unexpected answer: {err}"))
    }

    /// Revoke one device, or every one with `None`.
    pub async fn revoke(&self, device_id: Option<&str>) -> Result<Vec<String>, String> {
        #[derive(Deserialize)]
        struct Revoked {
            revoked: Vec<String>,
        }
        let params = match device_id {
            Some(id) => json!({ "deviceId": id }),
            None => json!({ "all": true }),
        };
        let answer = self.call(REVOKE_METHOD, params).await?;
        serde_json::from_value::<Revoked>(answer)
            .map(|list| list.revoked)
            .map_err(|err| format!("unexpected answer: {err}"))
    }
}

/// The QR code for a plain terminal: ANSI black on white half blocks.
pub fn qr_ansi(link: &str) -> String {
    const DARK_ON_LIGHT: [&str; 4] = [
        "\x1b[97;107m▀", // light over light
        "\x1b[97;40m▀",  // light over dark
        "\x1b[30;107m▀", // dark over light
        "\x1b[30;40m▀",  // dark over dark
    ];
    let mut out = String::new();
    for row in qr_rows(link).unwrap_or_default() {
        out.push_str("  ");
        for (top, bottom) in row {
            out.push_str(DARK_ON_LIGHT[usize::from(top) * 2 + usize::from(bottom)]);
        }
        out.push_str("\x1b[0m\n");
    }
    out
}

#[cfg(test)]
#[path = "unieai_remote_tests.rs"]
mod tests;
