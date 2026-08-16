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
