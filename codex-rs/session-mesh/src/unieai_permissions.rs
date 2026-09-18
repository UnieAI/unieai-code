// Copyright (c) 2026 UnieAI. All rights reserved.
//! How restricted a session is, and when a peer message must wait for the
//! recipient's user.
//!
//! # Restrictiveness
//!
//! A session's permission mode has two independent axes, each ordered from
//! most to least restricted:
//!
//! | rank | sandbox                                   | approval policy             |
//! |------|-------------------------------------------|-----------------------------|
//! | 0    | `read-only`                               | `untrusted` (ask for most)  |
//! | 1    | `workspace-write`                         | `on-request`, `granular`    |
//! | 2    | `danger-full-access`, `external-sandbox`  | `on-failure`                |
//! | 3    |                                           | `never` (never asks)        |
//!
//! The sandbox axis is what commands can touch without asking; the approval
//! axis is how readily the session runs something outside the sandbox without
//! a human in the loop.
//!
//! # The hold rule
//!
//! A message is delivered straight away when the recipient is at most as
//! permissive as the sender on *both* axes. If the recipient is more
//! permissive on *either* axis it could do something on the sender's behalf
//! that the sender could not do itself — permission laundering — so the
//! message is held until the recipient's user approves it.
//!
//! An unknown mode is treated pessimistically for the side it could harm: an
//! unknown sender counts as maximally restricted, an unknown recipient as
//! minimally restricted. Both default towards holding.

use std::fmt;

/// Filesystem reach, ordered from most to least restricted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SandboxLevel {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
}

impl SandboxLevel {
    /// Parses the config / wire spelling of a sandbox mode.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "read-only" | "readonly" | "read_only" => Some(Self::ReadOnly),
            "workspace-write" | "workspace_write" => Some(Self::WorkspaceWrite),
            "danger-full-access" | "danger_full_access" | "external-sandbox"
            | "external_sandbox" | "full-access" => Some(Self::FullAccess),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::FullAccess => "danger-full-access",
        }
    }
}

/// How readily actions run without asking, ordered from most to least
/// restricted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ApprovalLevel {
    Untrusted,
    OnRequest,
    OnFailure,
    Never,
}

impl ApprovalLevel {
    /// Parses the config / wire spelling of an approval policy.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "untrusted" | "unless-trusted" | "unless_trusted" => Some(Self::Untrusted),
            "on-request" | "on_request" | "granular" => Some(Self::OnRequest),
            "on-failure" | "on_failure" => Some(Self::OnFailure),
            "never" => Some(Self::Never),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Untrusted => "untrusted",
            Self::OnRequest => "on-request",
            Self::OnFailure => "on-failure",
            Self::Never => "never",
        }
    }
}

/// A session's permission mode at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PermissionMode {
    pub sandbox: SandboxLevel,
    pub approval: ApprovalLevel,
}

impl PermissionMode {
    /// The most restricted mode there is.
    pub const MOST_RESTRICTED: Self = Self {
        sandbox: SandboxLevel::ReadOnly,
        approval: ApprovalLevel::Untrusted,
    };

    /// The least restricted mode there is.
    pub const LEAST_RESTRICTED: Self = Self {
        sandbox: SandboxLevel::FullAccess,
        approval: ApprovalLevel::Never,
    };

    pub fn new(sandbox: SandboxLevel, approval: ApprovalLevel) -> Self {
        Self { sandbox, approval }
    }

    /// Parses a stored pair; `None` when either half is missing or unknown.
    pub fn parse(sandbox: Option<&str>, approval: Option<&str>) -> Option<Self> {
        Some(Self {
            sandbox: SandboxLevel::parse(sandbox?)?,
            approval: ApprovalLevel::parse(approval?)?,
        })
    }

    /// Whether `self` may do, without asking, something `other` could not.
    pub fn is_less_restricted_than(&self, other: &PermissionMode) -> bool {
        self.sandbox > other.sandbox || self.approval > other.approval
    }
}

impl fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "sandbox {}, approvals {}",
            self.sandbox.as_str(),
            self.approval.as_str()
        )
    }
}

/// Whether a message from `sender` to `recipient` must wait for the
/// recipient's user. See the module docs for the rule.
pub fn must_hold(sender: Option<&PermissionMode>, recipient: Option<&PermissionMode>) -> bool {
    let sender = sender.copied().unwrap_or(PermissionMode::MOST_RESTRICTED);
    let recipient = recipient
        .copied()
        .unwrap_or(PermissionMode::LEAST_RESTRICTED);
    recipient.is_less_restricted_than(&sender)
}

#[cfg(test)]
#[path = "unieai_permissions_tests.rs"]
mod unieai_permissions_tests;
