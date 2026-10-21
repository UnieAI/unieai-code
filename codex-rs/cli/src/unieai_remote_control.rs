// Copyright (c) 2026 UnieAI. All rights reserved.
//! `unieai remote-control` — Remote Control for the uac engine: watch, steer,
//! approve and answer this machine's sessions from a phone or browser.
//!
//! The uac server runs the bridge (see docs/unieai/remote-control-protocol.md);
//! this command asks it to start, prints the pairing link and its QR code,
//! and manages the devices paired with this machine. Upstream's ChatGPT-only
//! remote control is not reachable from here: on the uac engine it would
//! reach only the Rust child behind the uac server.

use anyhow::Context;
use codex_core::config::find_codex_home;
use codex_tui::UacRemoteControl;
use std::time::Duration;

#[derive(Debug, clap::Parser)]
pub struct RemoteControlCommand {
    #[command(subcommand)]
    subcommand: Option<RemoteControlSubcommand>,
}

#[derive(Debug, clap::Subcommand)]
enum RemoteControlSubcommand {
    /// Start Remote Control and show a pairing link (the default).
    Start(StartArgs),

    /// Stop Remote Control; paired devices stay paired.
    Stop,

    /// List the devices paired with this machine.
    Devices,

    /// Unpair a device (or every device with --all); its live session ends.
    Revoke(RevokeArgs),
}

#[derive(Debug, Default, clap::Args)]
struct StartArgs {
    /// Relay base URL, e.g. https://ava.example.com/api/remote (default:
    /// UNIEAI_REMOTE_RELAY_URL, then $CODEX_HOME/remote-control/settings.json,
    /// then https://agent.unieai.com/api/remote).
    #[arg(long, value_name = "URL")]
    relay: Option<String>,

    /// Print the link and exit instead of staying to show who is watching.
    #[arg(long)]
    detach: bool,
}

#[derive(Debug, clap::Args)]
struct RevokeArgs {
    /// The device id, as `unieai remote-control devices` lists it.
    #[arg(required_unless_present = "all")]
    device_id: Option<String>,

    /// Unpair every device.
    #[arg(long, conflicts_with = "device_id")]
    all: bool,
}

impl RemoteControlCommand {
    pub fn subcommand_name(&self) -> &'static str {
        match self.subcommand {
            None => "remote-control",
            Some(RemoteControlSubcommand::Start(_)) => "remote-control start",
            Some(RemoteControlSubcommand::Stop) => "remote-control stop",
            Some(RemoteControlSubcommand::Devices) => "remote-control devices",
            Some(RemoteControlSubcommand::Revoke(_)) => "remote-control revoke",
        }
    }
}

pub async fn run(command: RemoteControlCommand) -> anyhow::Result<()> {
    let codex_home = find_codex_home().context("failed to resolve CODEX_HOME")?;
    let remote = UacRemoteControl::connect(&codex_home)
        .await
        .map_err(anyhow::Error::msg)?;
    match command
        .subcommand
        .unwrap_or(RemoteControlSubcommand::Start(StartArgs::default()))
    {
        RemoteControlSubcommand::Start(args) => start(&remote, args).await,
        RemoteControlSubcommand::Stop => {
            remote.stop().await.map_err(anyhow::Error::msg)?;
            println!("Remote Control stopped. Paired devices stay paired.");
            Ok(())
        }
        RemoteControlSubcommand::Devices => {
            let devices = remote.devices().await.map_err(anyhow::Error::msg)?;
            if devices.is_empty() {
                println!("No devices are paired. Run `unieai remote-control` to pair one.");
            }
            for device in devices {
                let seen = device.last_seen_at.unwrap_or_default();
                let online = if device.online {
                    "  (watching now)"
                } else {
                    ""
                };
                println!("{}  {}  last seen {seen}{online}", device.id, device.name);
            }
            Ok(())
        }
        RemoteControlSubcommand::Revoke(args) => {
            let target = if args.all {
                None
            } else {
                args.device_id.as_deref()
            };
            let revoked = remote.revoke(target).await.map_err(anyhow::Error::msg)?;
            println!("Unpaired {}.", revoked.join(", "));
            Ok(())
        }
    }
}

async fn start(remote: &UacRemoteControl, args: StartArgs) -> anyhow::Result<()> {
    let info = remote
        .start(args.relay.as_deref())
        .await
        .map_err(anyhow::Error::msg)?;
    let Some(link) = info.link.as_deref() else {
        anyhow::bail!("the uac server did not return a pairing link");
    };
    println!("Open this link (or scan the code) on your phone or browser:\n\n  {link}\n");
    print!("{}", codex_tui::qr_ansi(link));
    println!(
        "\nThe link pairs one device, once, for 10 minutes. Paired devices reconnect without it.\n\
         Traffic is end-to-end encrypted; the relay ({}) sees only ciphertext.",
        info.relay_url.as_deref().unwrap_or("relay")
    );
    if args.detach {
        println!(
            "Remote Control runs while the uac server does (it stops when no UnieAI Code session is open)."
        );
        return Ok(());
    }
    // Staying connected keeps the uac server, and so Remote Control, running.
    println!(
        "Press Ctrl-C to stop watching; Remote Control keeps running while a session is open.\n"
    );
    let mut last = None;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
        let status = remote.status().await.map_err(anyhow::Error::msg)?;
        let line = if !status.running {
            "Remote Control stopped.".to_string()
        } else if let Some(error) = status.error.filter(|_| !status.connected) {
            format!("Reconnecting to the relay: {error}")
        } else {
            match status.viewers {
                1 => "Remote: 1 viewer".to_string(),
                n => format!("Remote: {n} viewers"),
            }
        };
        if last.as_ref() != Some(&line) {
            println!("{line}");
            last = Some(line);
        }
        if !status.running {
            return Ok(());
        }
    }
}
