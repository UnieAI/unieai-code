// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

fn entry(thread: &str, short_ref: &str, name: &str, text: &str) -> Value {
    json!({
        "from_thread_id": thread,
        "from_short_ref": short_ref,
        "from_name": name,
        "kind": "message",
        "framed": text,
    })
}

#[tokio::test]
async fn the_inbox_hands_over_what_matches_and_keeps_the_rest() {
    let inbox = Inbox::default();
    inbox.push(entry("t-api", "k2f8aaaa", "api", "from api"));
    inbox.push(entry("t-web", "9c1dbbbb", "web", "from web"));

    assert_eq!(
        messages_text(inbox.drain(Some("K2F8"))),
        "from api".to_string()
    );
    assert_eq!(messages_text(inbox.drain(None)), "from web".to_string());
    assert_eq!(messages_text(inbox.drain(None)), "No messages.".to_string());
}

#[tokio::test]
async fn a_wait_returns_when_a_message_arrives_and_gives_up_at_its_timeout() {
    let inbox = Arc::new(Inbox::default());
    let late = Arc::clone(&inbox);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        late.push(entry("t-api", "k2f8aaaa", "api", "answer"));
    });
    let got = inbox.wait(Some("api"), Duration::from_secs(5)).await;
    assert_eq!(messages_text(got), "answer".to_string());

    let none = inbox.wait(None, Duration::from_millis(20)).await;
    assert_eq!(none, Vec::<Value>::new());
}

#[test]
fn permissions_are_both_flags_or_neither() {
    let parse = |sandbox: Option<&str>, approval: Option<&str>| {
        parse_permissions(&PeersMcpCommand {
            sandbox: sandbox.map(str::to_string),
            approval: approval.map(str::to_string),
        })
    };
    assert_eq!(parse(None, None).unwrap(), None);
    assert_eq!(
        parse(Some("workspace-write"), Some("on-request")).unwrap(),
        Some(PermissionMode::new(
            SandboxLevel::WorkspaceWrite,
            ApprovalLevel::parse("on-request").unwrap()
        ))
    );
    assert!(parse(Some("workspace-write"), None).is_err());
    assert!(parse(Some("anything"), Some("never")).is_err());
}
