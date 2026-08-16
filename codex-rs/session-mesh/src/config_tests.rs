use super::*;
use pretty_assertions::assert_eq;

fn thread_id() -> ThreadId {
    ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b7c8d9e0f").expect("valid thread id")
}

#[test]
fn socket_paths_live_under_codex_home() {
    let config = MeshConfig::new("/home/user/.codex");

    assert_eq!(
        config.socket_path(thread_id()),
        PathBuf::from("/home/user/.codex/session-mesh/019460c8-1b2a-7c3d-8e4f-5a6b7c8d9e0f.sock")
    );
    assert_eq!(
        config.socket_lock_path(thread_id()),
        PathBuf::from(
            "/home/user/.codex/session-mesh/019460c8-1b2a-7c3d-8e4f-5a6b7c8d9e0f.sock.lock"
        )
    );
}

#[test]
fn socket_path_round_trips_through_thread_id_extraction() {
    let config = MeshConfig::new("/home/user/.codex");
    let path = config.socket_path(thread_id());

    assert_eq!(thread_id_from_socket_path(&path), Some(thread_id()));
}

#[test]
fn unrelated_paths_are_not_mistaken_for_session_sockets() {
    for path in [
        "/home/user/.codex/session-mesh/not-a-uuid.sock",
        // The lock file sits in the same directory and must not be read back
        // as a peer, or a reaper would treat it as an orphaned session.
        "/home/user/.codex/session-mesh/019460c8-1b2a-7c3d-8e4f-5a6b7c8d9e0f.sock.lock",
        "/home/user/.codex/session-mesh",
    ] {
        assert_eq!(
            thread_id_from_socket_path(Path::new(path)),
            None,
            "{path} should not resolve to a thread id"
        );
    }
}
