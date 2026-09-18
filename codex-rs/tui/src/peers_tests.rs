use super::*;
use pretty_assertions::assert_eq;
use unieai_session_mesh::PeerHandle;
use unieai_session_mesh::PeerStatus;
use unieai_session_mesh::short_ref_for;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

fn peer(tail: &str, name: Option<&str>) -> PeerHandle {
    let id = thread_id(tail);
    PeerHandle {
        thread_id: id,
        short_ref: short_ref_for(id),
        display_name: name.map(str::to_string),
        cwd: PathBuf::from("/w/api"),
        status: PeerStatus::Idle,
    }
}

#[test]
fn an_empty_mesh_and_a_broken_mesh_are_different_states() {
    // The whole point of this function: a user must be able to tell a quiet
    // machine from a misconfigured one, and an empty list says neither.
    assert_eq!(
        peer_bus_available(false, true, &AppServerTarget::Embedded),
        Err(PeerBusUnavailable::FeatureDisabled)
    );
    assert_eq!(
        peer_bus_available(true, false, &AppServerTarget::Embedded),
        Err(PeerBusUnavailable::NoStateDatabase)
    );
    assert_eq!(
        peer_bus_available(true, true, &AppServerTarget::Embedded),
        Ok(())
    );
}

#[test]
fn a_remote_app_server_must_not_show_this_machines_peers() {
    // The TUI can drive a core on another host. Listing local peers there would
    // name sessions the core it is driving cannot reach.
    assert_eq!(
        peer_bus_available(
            true,
            true,
            &AppServerTarget::Remote {
                endpoint: codex_app_server_client::RemoteAppServerEndpoint::WebSocket {
                    websocket_url: "ws://elsewhere/".to_string(),
                    auth_token: None,
                }
            }
        ),
        Err(PeerBusUnavailable::RemoteAppServer)
    );
}

#[test]
fn every_row_shares_one_short_ref_width() {
    let rows = peer_rows(&[
        peer("5a6b0c0d0e0f", Some("api")),
        peer("5a6b9a8b7c6d", Some("web")),
    ]);

    assert_eq!(rows.len(), 2);
    // One width for the listing, so a ref read in one row can be typed for any
    // row.
    let widths: Vec<usize> = rows
        .iter()
        .map(|row| row.handle.rsplit('[').next().unwrap_or_default().len())
        .collect();
    assert_eq!(widths[0], widths[1]);
    assert!(rows[0].handle.starts_with("api ["), "{}", rows[0].handle);
}

#[test]
fn a_sender_that_has_since_left_still_renders() {
    let rows = peer_rows(&[peer("5a6b0c0d0e0f", Some("api"))]);
    let gone = SessionMeshMessageRecord {
        message_id: "m-1".to_string(),
        from_thread_id: thread_id("5a6b9a8b7c6d"),
        to_thread_id: thread_id("5a6b0c0d0e0f"),
        content: "bye".to_string(),
        hop: 0,
        trigger_turn: true,
        created_at_ms: 0,
        delivered_at_ms: None,
        delivery: None,
        kind: "message".to_string(),
        sender_engine: None,
        sender_sandbox: None,
        sender_approval: None,
    };

    // A peer can vanish between sending and being rendered; the transcript must
    // still attribute the message rather than dropping the sender.
    let handle = sender_handle(&gone, &rows);

    assert_eq!(handle, short_ref_for(thread_id("5a6b9a8b7c6d")));
}

#[test]
fn a_peer_message_cell_names_its_sender_and_keeps_the_body() {
    let cell = PeerMessageCell::new("api [k2f8]".to_string(), "line one\nline two".to_string());

    let rendered: Vec<String> = cell
        .display_lines(80)
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect();

    assert_eq!(rendered[0], "peer message from api [k2f8]");
    assert!(rendered.contains(&"line one".to_string()), "{rendered:?}");
    assert!(rendered.contains(&"line two".to_string()), "{rendered:?}");
}

fn record(id: &str, created_at_ms: i64, delivery: Option<&str>) -> SessionMeshMessageRecord {
    SessionMeshMessageRecord {
        message_id: id.to_string(),
        from_thread_id: thread_id("5a6b9a8b7c6d"),
        to_thread_id: thread_id("5a6b0c0d0e0f"),
        content: format!("body of {id}"),
        hop: 0,
        trigger_turn: true,
        created_at_ms,
        delivered_at_ms: delivery.map(|_| created_at_ms),
        delivery: delivery.map(str::to_string),
        kind: "message".to_string(),
        sender_engine: Some("codex".to_string()),
        sender_sandbox: None,
        sender_approval: None,
    }
}

fn ids(messages: &[SessionMeshMessageRecord]) -> Vec<&str> {
    messages
        .iter()
        .map(|message| message.message_id.as_str())
        .collect()
}

#[test]
fn the_feed_shows_each_settled_message_once() {
    let mut feed = PeerFeed::new(1_000);

    // Still being decided: no card yet, or a message about to be held would
    // first appear as delivered.
    let first = feed.take_new(vec![
        record("pending", 1_500, None),
        record("delivering", 1_500, Some("delivering")),
        record("queued", 1_500, Some("queued")),
    ]);
    assert_eq!(ids(&first), vec!["queued"]);

    let second = feed.take_new(vec![
        record("pending", 1_500, Some("held")),
        record("delivering", 1_500, Some("started_turn")),
        record("queued", 1_500, Some("queued")),
    ]);
    assert_eq!(ids(&second), vec!["pending", "delivering"]);
}

#[test]
fn the_feed_skips_old_history_but_keeps_what_was_picked_up_or_held() {
    let mut feed = PeerFeed::new(1_000);
    let mut picked_up = record("picked-up", 10, Some("queued"));
    // Created while this session was not running, delivered at start.
    picked_up.delivered_at_ms = Some(1_200);

    let shown = feed.take_new(vec![
        record("seen-last-week", 10, Some("queued")),
        picked_up,
        record("still-held", 10, Some("held")),
    ]);

    assert_eq!(ids(&shown), vec!["picked-up", "still-held"]);
}

#[test]
fn listings_never_include_this_session() {
    let rows = peer_rows(&[
        peer("5a6b0c0d0e0f", Some("me")),
        peer("5a6b9a8b7c6d", Some("other")),
    ]);
    let others = exclude_thread(rows, Some(thread_id("5a6b0c0d0e0f")));
    assert_eq!(others.len(), 1);
    assert_eq!(others[0].thread_id, thread_id("5a6b9a8b7c6d"));
}

#[test]
fn cells_say_when_a_message_is_held_or_a_notice() {
    let render = |cell: PeerMessageCell| -> String {
        cell.display_lines(80)[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    };
    assert_eq!(
        render(PeerMessageCell::from_record(
            "api [k2f8]".to_string(),
            &record("h", 0, Some("held"))
        )),
        "peer message (held - awaiting your approval) from api [k2f8]"
    );
    let mut notice = record("n", 0, Some("queued"));
    notice.kind = "notice".to_string();
    assert_eq!(
        render(PeerMessageCell::from_record(
            "api [k2f8]".to_string(),
            &notice
        )),
        "delivery notice from api [k2f8]"
    );
}
