// Copyright (c) 2026 UnieAI. All rights reserved.
//! `unieai artifact` — pages published from UnieAI Code to the user's UnieAI
//! gallery (ava, agent.unieai.com): list, open, delete, publish, set.
//!
//! The same routes and id memory as the uac engine's `publish_artifact` tool
//! (see `codex_login::unieai_artifacts`), so publishing a path the agent
//! published before updates that page in place. Needs a Rabi login
//! (`unieai login --rabi`).

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use codex_login::unieai_artifacts::ArtifactHeader;
use codex_login::unieai_artifacts::ArtifactSummary;
use codex_login::unieai_artifacts::ArtifactsClient;
use codex_login::unieai_artifacts::IdMemory;
use codex_login::unieai_artifacts::PublishRequest;
use codex_login::unieai_artifacts::SettingsPatch;
use codex_login::unieai_artifacts::artifacts_account;
use codex_login::unieai_artifacts::open_in_browser;
use codex_login::unieai_artifacts::publish;
use codex_login::unieai_artifacts::workspace_root;

#[derive(Debug, clap::Parser)]
pub struct ArtifactCommand {
    #[command(subcommand)]
    subcommand: ArtifactSubcommand,
}

#[derive(Debug, PartialEq, clap::Subcommand)]
enum ArtifactSubcommand {
    /// List the pages published from UnieAI Code (and those shared with your org).
    #[clap(visible_alias = "ls")]
    List,
    /// Open a page in the browser.
    Open {
        /// The artifact id (see `unieai artifact list`).
        id: String,
    },
    /// Delete a page; its link stops working.
    #[clap(visible_alias = "rm")]
    Delete {
        /// The artifact id.
        id: String,
    },
    /// Publish an .html file or a directory with index.html. Publishing the
    /// same path again updates its page in place.
    Publish {
        /// An .html file (uploaded as index.html) or a directory with index.html.
        path: PathBuf,
        /// The page's name (default: its <title>).
        #[arg(long)]
        title: Option<String>,
        /// One sentence for the gallery card.
        #[arg(long)]
        description: Option<String>,
        /// Update this artifact instead of the one the path was published as.
        #[arg(long)]
        id: Option<String>,
        /// Who can see it (a new page is private; an update keeps the page's).
        #[arg(long, value_parser = ["private", "org"])]
        visibility: Option<String>,
        /// The organization to share with, when you belong to several.
        #[arg(long = "org-id", value_name = "ORG")]
        org_id: Option<String>,
        /// Overwrite the page even if it changed since this path's last publish.
        #[arg(long)]
        force: bool,
    },
    /// Change who can see a page and its viewer header (public is set in the web UI).
    Set {
        /// The artifact id.
        id: String,
        #[arg(long, value_parser = ["private", "org"])]
        visibility: Option<String>,
        /// The organization to share with, when you belong to several.
        #[arg(long = "org-id", value_name = "ORG")]
        org_id: Option<String>,
        /// Header title (the viewer draws the header above the page).
        #[arg(long = "header-title", value_name = "TEXT")]
        header_title: Option<String>,
        /// One line under the header title.
        #[arg(long = "header-description", value_name = "TEXT")]
        header_description: Option<String>,
        /// Header icon: a short generic word or an emoji.
        #[arg(long = "header-icon", value_name = "ICON")]
        header_icon: Option<String>,
        /// Show the author's name in the header.
        #[arg(long = "show-author", value_name = "BOOL")]
        show_author: Option<bool>,
        /// Remove the header settings.
        #[arg(long = "clear-header", conflicts_with_all = ["header_title", "header_description", "header_icon", "show_author"])]
        clear_header: bool,
    },
}

pub async fn run_artifact_command(command: ArtifactCommand) -> anyhow::Result<()> {
    let codex_home = codex_core::config::find_codex_home()?;
    let cwd = std::env::current_dir()?;
    let mut stdout = std::io::stdout();
    run(
        command,
        codex_home.as_path(),
        &cwd,
        &mut stdout,
        &|url: &str| open_in_browser(url),
    )
    .await
}

fn write_items(
    out: &mut impl Write,
    client: &ArtifactsClient,
    memory: &IdMemory,
    items: &[ArtifactSummary],
) -> std::io::Result<()> {
    for item in items {
        let version = item.version.map(|v| format!("  v{v}")).unwrap_or_default();
        let updated = item
            .updated_at
            .as_ref()
            .map(|at| format!("  {at}"))
            .unwrap_or_default();
        writeln!(out, "{}  {}{version}{updated}", item.id, item.title)?;
        writeln!(out, "    {}", client.absolute(item.link()))?;
        for path in memory.paths_of(&item.id) {
            writeln!(out, "    from {}", path.display())?;
        }
    }
    Ok(())
}

async fn run(
    command: ArtifactCommand,
    codex_home: &Path,
    cwd: &Path,
    out: &mut impl Write,
    open: &dyn Fn(&str) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    let client = ArtifactsClient::new(artifacts_account(codex_home)?);
    let memory = IdMemory::new(codex_home);
    match command.subcommand {
        ArtifactSubcommand::List => {
            let list = client.list().await?;
            if list.mine.is_empty() {
                writeln!(out, "No artifacts published from UnieAI Code yet.")?;
            }
            write_items(out, &client, &memory, &list.mine)?;
            if !list.org.is_empty() {
                writeln!(out, "Shared with your organization:")?;
                write_items(out, &client, &memory, &list.org)?;
            }
            if let Some(serde_json::Value::Object(usage)) = &list.usage {
                let parts: Vec<String> = usage
                    .iter()
                    .map(|(key, value)| {
                        let limit = list
                            .limits
                            .as_ref()
                            .and_then(|limits| limits.get(key))
                            .map(|limit| format!("/{limit}"))
                            .unwrap_or_default();
                        format!("{key} {value}{limit}")
                    })
                    .collect();
                if !parts.is_empty() {
                    writeln!(out, "Usage: {}", parts.join(", "))?;
                }
            }
        }
        ArtifactSubcommand::Open { id } => {
            let meta = client.get(&id).await?;
            let url = meta
                .get("viewerUrl")
                .or_else(|| meta.get("url"))
                .and_then(serde_json::Value::as_str)
                .map(|url| client.absolute(url))
                .ok_or_else(|| anyhow::anyhow!("ava returned no viewer URL for {id}"))?;
            writeln!(out, "{url}")?;
            if let Err(err) = open(&url) {
                writeln!(
                    out,
                    "Could not open a browser ({err}); open the link above."
                )?;
            }
        }
        ArtifactSubcommand::Delete { id } => {
            client.delete(&id, None).await?;
            memory.forget(&id)?;
            writeln!(out, "Deleted {id}; its link no longer works.")?;
        }
        ArtifactSubcommand::Publish {
            path,
            title,
            description,
            id,
            visibility,
            org_id,
            force,
        } => {
            // Lexically, like the uac tool's path.resolve, so both remember
            // the same key for the same file.
            let path = resolve(cwd, &path);
            let workspace = workspace_root(cwd);
            let outcome = publish(
                &client,
                &memory,
                &workspace,
                PublishRequest {
                    path,
                    title,
                    description,
                    id,
                    visibility,
                    org_id,
                    force,
                },
            )
            .await?;
            let verb = if outcome.created {
                "Published"
            } else {
                "Updated"
            };
            writeln!(
                out,
                "{verb} \"{}\" (id {}, version {})",
                outcome.title, outcome.id, outcome.version
            )?;
            writeln!(out, "{}", outcome.viewer_url)?;
        }
        ArtifactSubcommand::Set {
            id,
            visibility,
            org_id,
            header_title,
            header_description,
            header_icon,
            show_author,
            clear_header,
        } => {
            let header = ArtifactHeader {
                title: header_title,
                description: header_description,
                icon: header_icon,
                show_author,
            };
            let patch = SettingsPatch {
                visibility,
                org_id,
                header: if clear_header {
                    Some(None)
                } else if header.is_empty() {
                    None
                } else {
                    Some(Some(header))
                },
            };
            if patch.visibility.is_none() && patch.header.is_none() {
                anyhow::bail!(
                    "nothing to change: pass --visibility, a --header-* option, --show-author or --clear-header"
                );
            }
            let published = client.update_settings(&id, &patch).await?;
            writeln!(out, "Updated the settings of {id}.")?;
            if !published.viewer_url.is_empty() {
                writeln!(out, "{}", client.absolute(&published.viewer_url))?;
            }
        }
    }
    Ok(())
}

/// `cwd`/`path` with `.` and `..` folded away, without touching the disk.
fn resolve(cwd: &Path, path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in cwd.join(path).components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
#[path = "unieai_artifact_tests.rs"]
mod tests;
