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

#[test]
fn a_deep_codex_home_falls_back_to_a_short_shared_socket_directory() {
    let deep = format!("/home/user/{}/.codex", "nested/".repeat(12));
    let config = MeshConfig::new(&deep);

    let socket = config.socket_path(thread_id());
    assert!(
        socket.as_os_str().len() < MAX_SOCKET_PATH_LEN,
        "{}",
        socket.display()
    );
    assert!(!socket.starts_with(&deep));
    // Another session on the same home computes the same directory; a
    // different home does not.
    assert_eq!(MeshConfig::new(&deep).socket_dir(), config.socket_dir());
    assert_ne!(
        MeshConfig::new(format!("{deep}2")).socket_dir(),
        config.socket_dir()
    );
    // Child logs stay with the home, not in the runtime directory.
    assert!(config.child_log_dir().starts_with(&deep));
}
