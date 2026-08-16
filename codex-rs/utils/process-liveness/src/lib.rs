//! Whether a recorded process is still the process that made the record.
//!
//! A bare pid is not an identity: pids are recycled, so a stale record can name
//! a live but unrelated process. Pairing the pid with a start token — a value
//! that changes whenever the kernel reuses the pid — makes the record
//! falsifiable. Pairing that with a boot id makes it survive a reboot, after
//! which start tokens restart from zero and would otherwise collide.
//!
//! This is a *pre-filter*, not proof of service. It answers "is that process
//! gone?" cheaply so callers can skip the expensive real check (connecting to a
//! socket, say) for records that are obviously dead. A `true` here means
//! "possibly alive"; only the real check can promote that to "alive".

use std::io;
use std::path::Path;

/// Identity of a running process, stable for as long as that process lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// Opaque, platform-specific. Compare for equality; never parse.
    pub start_token: String,
    /// Identifies the boot the token was minted in; start tokens are only
    /// comparable within a boot.
    pub boot_id: String,
}

impl ProcessIdentity {
    /// Captures the identity of the calling process.
    pub async fn current() -> io::Result<Self> {
        Self::for_pid(std::process::id()).await
    }

    /// Captures the identity of `pid`.
    pub async fn for_pid(pid: u32) -> io::Result<Self> {
        Ok(Self {
            pid,
            start_token: read_start_token(pid).await?,
            boot_id: boot_id().await?,
        })
    }

    /// Returns whether the process this identity describes may still be running.
    ///
    /// A different boot, a missing process, or a mismatched start token are all
    /// conclusive negatives. Anything else is "possibly alive" and must be
    /// confirmed by the caller's real liveness check.
    pub async fn is_possibly_alive(&self) -> bool {
        match boot_id().await {
            Ok(current_boot_id) if current_boot_id != self.boot_id => return false,
            // An unreadable boot id must not turn a live process into a dead
            // one; fall through to the pid checks, which are still sound
            // within a boot.
            Ok(_) | Err(_) => {}
        }

        if !process_exists(self.pid) {
            return false;
        }

        match read_start_token(self.pid).await {
            Ok(start_token) => start_token == self.start_token,
            // The process may have exited between the two calls, which is a
            // conclusive negative. Otherwise we simply cannot tell, and must
            // not claim the process is gone.
            Err(_) => process_exists(self.pid),
        }
    }
}

/// Returns whether a process with `pid` currently exists.
///
/// `EPERM` counts as existing: the process is there, we just do not own it.
pub fn process_exists(pid: u32) -> bool {
    platform::process_exists(pid)
}

/// Returns an opaque token that changes when `pid` is recycled.
pub async fn read_start_token(pid: u32) -> io::Result<String> {
    platform::read_start_token(pid).await
}

/// Returns an identifier for the current boot.
///
/// Start tokens on Linux count from boot, so they collide across reboots; this
/// disambiguates them. Platforms without a real boot id return a constant,
/// which is sound because their start tokens are wall-clock based.
pub async fn boot_id() -> io::Result<String> {
    platform::boot_id().await
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    const BOOT_ID_PATH: &str = "/proc/sys/kernel/random/boot_id";

    pub(super) fn process_exists(pid: u32) -> bool {
        unix_process_exists(pid)
    }

    /// Reads field 22 (`starttime`) of `/proc/<pid>/stat`, in clock ticks since
    /// boot.
    ///
    /// Deliberately avoids spawning `ps`: this runs once per candidate peer on
    /// every listing, and a subprocess per peer is not a pre-filter.
    pub(super) async fn read_start_token(pid: u32) -> io::Result<String> {
        let stat = tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await?;
        parse_start_time_field(&stat).map(|start_time| format!("linux:{start_time}"))
    }

    pub(super) async fn boot_id() -> io::Result<String> {
        Ok(tokio::fs::read_to_string(Path::new(BOOT_ID_PATH))
            .await?
            .trim()
            .to_string())
    }

    /// The `comm` field is unquoted and may itself contain spaces and
    /// parentheses, so fields are only unambiguous after the final `)`.
    pub(super) fn parse_start_time_field(stat: &str) -> io::Result<String> {
        let after_comm = stat
            .rfind(')')
            .map(|index| &stat[index + 1..])
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "malformed /proc stat line")
            })?;

        // After `comm` the fields are: state, ppid, pgrp, session, tty_nr,
        // tpgid, flags, minflt, cminflt, majflt, cmajflt, utime, stime,
        // cutime, cstime, priority, nice, num_threads, itrealvalue, starttime.
        // `state` is field 3, so `starttime` (field 22) is the 20th token here.
        after_comm
            .split_whitespace()
            .nth(19)
            .map(str::to_string)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "/proc stat line is missing the starttime field",
                )
            })
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
mod platform {
    use super::*;

    pub(super) fn process_exists(pid: u32) -> bool {
        unix_process_exists(pid)
    }

    /// No `/proc` here, so shell out. This is the reason non-Linux callers
    /// should probe sparingly.
    pub(super) async fn read_start_token(pid: u32) -> io::Result<String> {
        let output = tokio::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .output()
            .await?;
        if !output.status.success() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("ps reported no start time for pid {pid}"),
            ));
        }
        let start_time = String::from_utf8(output.stdout)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        let start_time = start_time.trim();
        if start_time.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("pid {pid} has no recorded start time"),
            ));
        }
        Ok(format!("ps:{start_time}"))
    }

    pub(super) async fn boot_id() -> io::Result<String> {
        // `lstart` is wall-clock, so it does not collide across reboots and
        // needs no boot disambiguator.
        let _ = Path::new("/");
        Ok("wallclock".to_string())
    }
}

#[cfg(unix)]
fn unix_process_exists(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 performs permission and existence checks without
    // delivering a signal.
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
mod platform {
    use super::*;

    pub(super) fn process_exists(_pid: u32) -> bool {
        // Without a peer-credential check there is no safe way to act on the
        // answer, so callers on Windows are expected to gate the feature off
        // entirely rather than trust a weaker signal.
        false
    }

    pub(super) async fn read_start_token(pid: u32) -> io::Result<String> {
        let _ = Path::new("/");
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("process start tokens are unsupported on this platform (pid {pid})"),
        ))
    }

    pub(super) async fn boot_id() -> io::Result<String> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "boot ids are unsupported on this platform",
        ))
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod lib_tests;
