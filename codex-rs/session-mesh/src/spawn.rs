//! Launching a session that outlives the one that asked for it.
//!
//! A detached process rather than an in-process sub-agent, because the four
//! things "background session" implies to a user are all things an in-process
//! child structurally cannot do: survive the parent exiting, run in a different
//! workspace, run under a different model or sandbox policy, and be discovered
//! and messaged from another terminal. Sessions that should *not* outlive their
//! parent already have a better answer in `spawn_agent`.

use std::path::PathBuf;
use std::process::Stdio;

use codex_protocol::ThreadId;
use tokio::time::Instant;
use tokio::time::sleep;

use crate::error::MeshError;

/// Environment carrying the parent's identity into the child.
///
/// Chosen over CLI flags deliberately: flags would have to be threaded through
/// the exec argument parser, the config loader, and session construction to
/// reach the mesh, and every one of those layers would gain a field it has no
/// other use for. The parent-child link is exactly what process environment is
/// for.
pub const SPAWN_ID_ENV: &str = "UNIEAI_MESH_SPAWN_ID";
pub const SPAWN_PARENT_ENV: &str = "UNIEAI_MESH_PARENT";

/// What to launch.
#[derive(Debug, Clone)]
pub struct SpawnChildParams {
    /// The task the child should carry out.
    pub prompt: String,
    /// Working directory for the child. Defaults to the parent's.
    pub cwd: Option<PathBuf>,
}

/// How the launch went, for the caller to report.
#[derive(Debug, Clone)]
pub struct SpawnedChild {
    pub thread_id: ThreadId,
    pub pid: u32,
    pub log_path: PathBuf,
}

/// Builds the detached child command.
///
/// Split out so the argument construction is testable without spawning
/// anything: getting `setsid` or the redirects wrong is only visible at
/// runtime, but getting the arguments wrong is not.
pub(crate) fn child_command(
    exe: &std::path::Path,
    params: &SpawnChildParams,
    spawn_id: &str,
    parent: ThreadId,
    // Two handles rather than one cloned handle: stdout and stderr each need
    // their own, and a failure to duplicate must not be papered over.
    stdout: std::fs::File,
    stderr: std::fs::File,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(exe);
    command
        .arg("exec")
        .arg("--skip-git-repo-check")
        .arg(&params.prompt)
        .env(SPAWN_ID_ENV, spawn_id)
        .env(SPAWN_PARENT_ENV, parent.to_string())
        // No terminal, so reading stdin would block forever.
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        // The whole point is to outlive this process.
        .kill_on_drop(false);
    if let Some(cwd) = params.cwd.as_ref() {
        command.current_dir(cwd);
    }

    #[cfg(unix)]
    unsafe {
        // A new session detaches the child from this terminal's process group,
        // so Ctrl-C here does not take the child down with it.
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    command
}

/// Waits for a freshly launched child to publish its registry row.
///
/// Polls rather than waits on a channel because the child is a separate
/// process that may fail before it ever reaches the mesh; a poll with a
/// deadline reports that as a timeout instead of hanging.
pub(crate) async fn await_rendezvous<F, Fut>(
    spawn_id: &str,
    timeout: std::time::Duration,
    log_path: &std::path::Path,
    lookup: F,
) -> Result<ThreadId, MeshError>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Option<ThreadId>, MeshError>>,
{
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(thread_id) = lookup(spawn_id.to_string()).await? {
            return Ok(thread_id);
        }
        if Instant::now() >= deadline {
            return Err(MeshError::Wire(format!(
                "the child session did not register within {timeout:?}; its output is at {}",
                log_path.display()
            )));
        }
        sleep(std::time::Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
#[path = "spawn_tests.rs"]
mod spawn_tests;
