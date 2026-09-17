// Copyright (c) 2026 UnieAI. All rights reserved.
//! Which agent engine a new session runs on, and how to reach the non-default one.
//!
//! `codex` is the embedded Rust engine. `uac` (unieai-agent-core) is served by
//! `agent-runtime/bin/unieai-uac-server.mjs`, which answers the app-server protocol's
//! engine methods by driving deepseek-harness (`dsh`) over ACP and forwards every
//! other method to the Rust app-server. The TUI reaches it as a local daemon on
//! its own socket, so the upstream daemon socket keeps its meaning.
//!
//! The choice is stored in `$CODEX_HOME/engine` and read at startup;
//! `UNIEAI_ENGINE` overrides it for one launch. `/engine` writes the file and
//! relaunches, because an app-server connection is not swapped mid-session.

use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use codex_utils_absolute_path::AbsolutePathBuf;

pub(crate) const ENGINE_ENV_VAR: &str = "UNIEAI_ENGINE";
/// Path to the uac server script, when it is not next to the executable.
pub(crate) const UAC_SERVER_ENV_VAR: &str = "UNIEAI_UAC_SERVER";
const ENGINE_FILE: &str = "engine";
const UAC_DIR: &str = "uac";
const UAC_SOCKET: &str = "app-server.sock";
const UAC_LOG: &str = "server.log";
const UAC_SCRIPT: &str = "agent-runtime/bin/unieai-uac-server.mjs";
const UAC_START_TIMEOUT: Duration = Duration::from_secs(20);
const UAC_PROBE_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EngineKind {
    Codex,
    Uac,
}

impl EngineKind {
    pub(crate) const ALL: [EngineKind; 2] = [EngineKind::Codex, EngineKind::Uac];

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "codex" => Some(Self::Codex),
            "uac" | "unieai-agent-core" => Some(Self::Uac),
            _ => None,
        }
    }

    /// The value written to the engine file and accepted by `/engine`.
    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Uac => "uac",
        }
    }

    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Uac => "unieai-agent-core (uac)",
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Codex => "built-in Rust engine",
            Self::Uac => "unieai-agent-core engine (deepseek-harness over ACP)",
        }
    }
}

fn engine_file(codex_home: &Path) -> PathBuf {
    codex_home.join(ENGINE_FILE)
}

/// The engine configured for new sessions, ignoring the environment override.
pub(crate) fn configured_engine(codex_home: &Path) -> EngineKind {
    std::fs::read_to_string(engine_file(codex_home))
        .ok()
        .and_then(|raw| EngineKind::parse(&raw))
        .unwrap_or(EngineKind::Codex)
}

/// Why the signed-in account cannot run `engine`, if it cannot. A UnieAI
/// Rabi account's relay serves chat completions only, which the codex engine
/// (Responses API) cannot use.
pub(crate) fn engine_unavailable_reason(codex_home: &Path, engine: EngineKind) -> Option<String> {
    let account = codex_login::unieai::load_unieai_credentials(codex_home)?.account;
    (engine == EngineKind::Codex && !account.supports_codex_engine()).then(|| {
        format!(
            "Not available with a {} account; it runs on {}.",
            account.display_name(),
            EngineKind::Uac.display_name()
        )
    })
}

/// The engine a session connected to `target` runs on (it can differ from
/// the configured one when the uac server failed to start).
pub(crate) fn target_engine(codex_home: &Path, target: &crate::AppServerTarget) -> EngineKind {
    match target {
        crate::AppServerTarget::LocalDaemon {
            endpoint: crate::RemoteAppServerEndpoint::UnixSocket { socket_path },
            ..
        } if is_uac_socket(codex_home, socket_path.as_path()) => EngineKind::Uac,
        _ => EngineKind::Codex,
    }
}

/// Whether a session on `target` must restart onto another engine because
/// the account signed in during onboarding cannot use this one.
pub(crate) fn needs_engine_relaunch(codex_home: &Path, target: &crate::AppServerTarget) -> bool {
    engine_unavailable_reason(codex_home, target_engine(codex_home, target)).is_some()
}

/// The engine this launch should use.
pub(crate) fn resolve_engine(codex_home: &Path) -> EngineKind {
    let requested = requested_engine(codex_home);
    if let Some(reason) = engine_unavailable_reason(codex_home, requested) {
        tracing::info!("{} {reason}", requested.display_name());
        return EngineKind::Uac;
    }
    requested
}

fn requested_engine(codex_home: &Path) -> EngineKind {
    match std::env::var(ENGINE_ENV_VAR) {
        Ok(raw) if !raw.trim().is_empty() => EngineKind::parse(&raw).unwrap_or_else(|| {
            tracing::warn!(value = %raw, "ignoring unknown {ENGINE_ENV_VAR}");
            configured_engine(codex_home)
        }),
        _ => configured_engine(codex_home),
    }
}

pub(crate) fn write_engine(codex_home: &Path, engine: EngineKind) -> std::io::Result<()> {
    std::fs::create_dir_all(codex_home)?;
    std::fs::write(engine_file(codex_home), format!("{}\n", engine.id()))
}

/// Unix socket paths are capped at 108 bytes (104 on macOS) including the NUL;
/// a longer one is silently truncated by the server's bind.
const MAX_SOCKET_PATH_BYTES: usize = 100;

pub(crate) fn uac_socket_path(codex_home: &Path) -> PathBuf {
    let preferred = codex_home.join(UAC_DIR).join(UAC_SOCKET);
    if preferred.as_os_str().len() <= MAX_SOCKET_PATH_BYTES {
        return preferred;
    }
    // A deep CODEX_HOME: use a per-home name under a private temp directory.
    short_socket_dir().join(format!(
        "{:016x}.sock",
        fnv1a(codex_home.as_os_str().as_encoded_bytes())
    ))
}

fn short_socket_dir() -> PathBuf {
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    std::env::temp_dir().join(format!("unieai-uac-{user}"))
}

/// Stable across builds, unlike `DefaultHasher`, so every binary picks the
/// same socket for the same home.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

/// Create the socket's directory owner-only, so a temp-dir fallback is not
/// reachable by other users.
fn prepare_socket_dir(socket: &Path) -> std::io::Result<()> {
    let Some(dir) = socket.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::symlink_metadata(dir)?;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        if !metadata.is_dir() || metadata.uid() != uid {
            return Err(std::io::Error::other(format!(
                "{} is not a directory owned by this user",
                dir.display()
            )));
        }
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(crate) fn uac_log_path(codex_home: &Path) -> PathBuf {
    codex_home.join(UAC_DIR).join(UAC_LOG)
}

/// Whether `socket` is the uac server's socket for this home.
pub(crate) fn is_uac_socket(codex_home: &Path, socket: &Path) -> bool {
    socket == uac_socket_path(codex_home)
}

/// Find the uac server script: the env override, then next to the executable
/// (walking up, which covers both packaged and `target/<profile>` layouts).
fn locate_uac_script() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(UAC_SERVER_ENV_VAR) {
        return Some(PathBuf::from(path));
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .map(|dir| dir.join(UAC_SCRIPT))
        .find(|candidate| candidate.is_file())
}

async fn socket_is_live(socket: &Path) -> bool {
    matches!(
        tokio::time::timeout(
            UAC_PROBE_INTERVAL * 4,
            codex_uds::UnixStream::connect(socket)
        )
        .await,
        Ok(Ok(_))
    )
}

/// Return the uac server's socket, starting the server first if nothing is
/// listening. The server is detached so it outlives this TUI, like the upstream
/// daemon, and later launches reuse it.
pub(crate) async fn ensure_uac_server(codex_home: &Path) -> std::io::Result<AbsolutePathBuf> {
    let socket = uac_socket_path(codex_home);
    let socket_abs = AbsolutePathBuf::from_absolute_path_checked(&socket)?;
    if socket_is_live(&socket).await {
        return Ok(socket_abs);
    }
    let script = locate_uac_script().ok_or_else(|| {
        std::io::Error::other(format!(
            "cannot find {UAC_SCRIPT}; set {UAC_SERVER_ENV_VAR} to its path"
        ))
    })?;
    prepare_socket_dir(&socket)?;
    let log_path = uac_log_path(codex_home);
    if let Some(dir) = log_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let mut command = tokio::process::Command::new(
        std::env::var_os("UNIEAI_NODE").unwrap_or_else(|| "node".into()),
    );
    command
        .arg(&script)
        .env("CODEX_HOME", codex_home)
        .env("UNIEAI_APP_SERVER_SOCKET", &socket)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone()?))
        .stderr(Stdio::from(log))
        .kill_on_drop(false);
    if let Ok(exe) = std::env::current_exe() {
        // The server forwards platform methods to this same binary's app-server.
        command.env("UNIEAI_BIN", exe);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|err| {
        std::io::Error::other(format!(
            "failed to start uac server ({}): {err}",
            script.display()
        ))
    })?;

    let deadline = tokio::time::Instant::now() + UAC_START_TIMEOUT;
    loop {
        if socket_is_live(&socket).await {
            // Reap the child in the background if it ever exits while we run.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            return Ok(socket_abs);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(std::io::Error::other(format!(
                "uac server exited with {status}; see {}",
                log_path.display()
            )));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(std::io::Error::other(format!(
                "uac server did not start within {}s; see {}",
                UAC_START_TIMEOUT.as_secs(),
                log_path.display()
            )));
        }
        tokio::time::sleep(UAC_PROBE_INTERVAL).await;
    }
}

#[cfg(test)]
#[path = "unieai_engine_tests.rs"]
mod tests;
