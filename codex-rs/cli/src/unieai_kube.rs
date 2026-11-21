// Copyright (c) 2026 UnieAI. All rights reserved.
//! `unieai kube` — kubectl access to UnieAI Studio vClusters with short-lived,
//! per-person credentials.
//!
//! `unieai kube kubeconfig <vCluster>` writes a kubeconfig whose user runs
//! `unieai kube token`; kubectl then calls that plugin, which exchanges the
//! Studio sign-in from `unieai login` for a 15-minute token (see
//! `codex_login::unieai_kube`). The kubeconfig holds no secret.

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use codex_login::unieai_kube::clear_kube_token_cache;
use codex_login::unieai_kube::kube_kubeconfig;
use codex_login::unieai_kube::kube_token;

#[derive(Debug, clap::Parser)]
pub struct KubeCommand {
    #[command(subcommand)]
    subcommand: KubeSubcommand,
}

#[derive(Debug, PartialEq, clap::Subcommand)]
enum KubeSubcommand {
    /// Print a 15-minute token for a vCluster as a kubectl ExecCredential
    /// (kubectl runs this; you rarely need to).
    Token {
        /// The vCluster id (shown on its page in UnieAI Studio).
        #[arg(long = "cluster", value_name = "VCLUSTER")]
        cluster: String,
        /// The Studio the kubeconfig was issued by; must match your sign-in.
        #[arg(long = "studio", value_name = "URL")]
        studio: Option<String>,
    },
    /// Download a kubeconfig for a vCluster that signs in through `unieai kube token`.
    Kubeconfig {
        /// The vCluster id (shown on its page in UnieAI Studio).
        cluster: String,
        /// Where to write it (default: the file name Studio suggests, in the
        /// current directory). `-` prints it.
        #[arg(short = 'o', long = "output", value_name = "FILE")]
        output: Option<PathBuf>,
    },
    /// Forget every cached vCluster token on this computer.
    Logout,
}

pub async fn run_kube_command(command: KubeCommand) -> anyhow::Result<()> {
    let codex_home = codex_core::config::find_codex_home()?;
    let cwd = std::env::current_dir()?;
    let mut stdout = std::io::stdout();
    run(command, codex_home.as_path(), &cwd, &mut stdout).await
}

async fn run(
    command: KubeCommand,
    codex_home: &Path,
    cwd: &Path,
    out: &mut impl Write,
) -> anyhow::Result<()> {
    match command.subcommand {
        KubeSubcommand::Token { cluster, studio } => {
            // kubectl shows the plugin's stderr; the error text says what to do.
            let credential = kube_token(codex_home, &cluster, studio.as_deref()).await?;
            serde_json::to_writer(&mut *out, &credential)?;
            writeln!(out)?;
        }
        KubeSubcommand::Kubeconfig { cluster, output } => {
            let (kubeconfig, file_name) = kube_kubeconfig(codex_home, &cluster).await?;
            match output {
                Some(path) if path.as_os_str() == "-" => write!(out, "{kubeconfig}")?,
                other => {
                    let path = match other {
                        Some(path) if path.is_absolute() => path,
                        Some(path) => cwd.join(path),
                        None => cwd.join(&file_name),
                    };
                    write_private(&path, &kubeconfig)?;
                    writeln!(out, "Wrote {}", path.display())?;
                    writeln!(
                        out,
                        "Use it with: KUBECONFIG={} kubectl get pods",
                        path.display()
                    )?;
                }
            }
        }
        KubeSubcommand::Logout => {
            let removed = clear_kube_token_cache(codex_home)?;
            writeln!(out, "Removed {removed} cached vCluster token(s).")?;
        }
    }
    Ok(())
}

/// kubeconfigs are read by kubectl only; keep them owner-only like ~/.kube/config.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use pretty_assertions::assert_eq;

    #[derive(Debug, clap::Parser)]
    struct Cli {
        #[command(flatten)]
        kube: KubeCommand,
    }

    #[test]
    fn parses_the_plugin_invocation_the_kubeconfig_uses() {
        let cli = Cli::try_parse_from([
            "kube",
            "token",
            "--cluster",
            "cluster_vc1",
            "--studio",
            "https://studio.example",
        ])
        .expect("parse");
        assert_eq!(
            cli.kube.subcommand,
            KubeSubcommand::Token {
                cluster: "cluster_vc1".to_string(),
                studio: Some("https://studio.example".to_string()),
            }
        );
    }

    #[test]
    fn parses_kubeconfig_and_logout() {
        let cli =
            Cli::try_parse_from(["kube", "kubeconfig", "cluster_vc1", "-o", "-"]).expect("parse");
        assert_eq!(
            cli.kube.subcommand,
            KubeSubcommand::Kubeconfig {
                cluster: "cluster_vc1".to_string(),
                output: Some(PathBuf::from("-")),
            }
        );
        let cli = Cli::try_parse_from(["kube", "logout"]).expect("parse");
        assert_eq!(cli.kube.subcommand, KubeSubcommand::Logout);
    }

    #[tokio::test]
    async fn logout_with_nothing_cached_reports_zero() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut out = Vec::new();
        run(
            KubeCommand {
                subcommand: KubeSubcommand::Logout,
            },
            home.path(),
            home.path(),
            &mut out,
        )
        .await
        .expect("logout");
        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "Removed 0 cached vCluster token(s).\n"
        );
    }
}
