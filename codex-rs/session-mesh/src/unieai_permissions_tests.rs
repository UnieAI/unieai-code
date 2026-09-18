// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

fn mode(sandbox: &str, approval: &str) -> PermissionMode {
    PermissionMode::parse(Some(sandbox), Some(approval)).expect("known mode")
}

#[test]
fn a_less_restricted_sender_is_delivered_directly() {
    let sender = mode("danger-full-access", "never");
    let recipient = mode("read-only", "on-request");
    assert!(!must_hold(Some(&sender), Some(&recipient)));
}

#[test]
fn equal_modes_are_delivered_directly() {
    let both = mode("workspace-write", "on-request");
    assert!(!must_hold(Some(&both), Some(&both)));
}

#[test]
fn a_recipient_with_a_wider_sandbox_holds_the_message() {
    let sender = mode("read-only", "on-request");
    let recipient = mode("workspace-write", "on-request");
    assert!(must_hold(Some(&sender), Some(&recipient)));
}

#[test]
fn a_recipient_that_asks_less_often_holds_the_message() {
    // Same sandbox, but the recipient never asks: it could run an escalated
    // command the sender would have had to get approved.
    let sender = mode("workspace-write", "on-request");
    let recipient = mode("workspace-write", "never");
    assert!(must_hold(Some(&sender), Some(&recipient)));
}

#[test]
fn unknown_modes_default_towards_holding() {
    let middle = mode("workspace-write", "on-request");
    assert!(must_hold(None, Some(&middle)));
    assert!(must_hold(Some(&middle), None));
    assert!(!must_hold(Some(&PermissionMode::LEAST_RESTRICTED), None));
    assert!(!must_hold(None, Some(&PermissionMode::MOST_RESTRICTED)));
}

#[test]
fn spellings_round_trip() {
    for sandbox in [
        SandboxLevel::ReadOnly,
        SandboxLevel::WorkspaceWrite,
        SandboxLevel::FullAccess,
    ] {
        assert_eq!(SandboxLevel::parse(sandbox.as_str()), Some(sandbox));
    }
    for approval in [
        ApprovalLevel::Untrusted,
        ApprovalLevel::OnRequest,
        ApprovalLevel::OnFailure,
        ApprovalLevel::Never,
    ] {
        assert_eq!(ApprovalLevel::parse(approval.as_str()), Some(approval));
    }
    assert_eq!(
        SandboxLevel::parse("external-sandbox"),
        Some(SandboxLevel::FullAccess)
    );
    assert_eq!(
        ApprovalLevel::parse("granular"),
        Some(ApprovalLevel::OnRequest)
    );
    assert_eq!(PermissionMode::parse(Some("read-only"), None), None);
}
