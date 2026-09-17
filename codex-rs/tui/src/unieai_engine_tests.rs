// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;
use std::path::PathBuf;

#[test]
fn parse_accepts_ids_and_full_name() {
    assert_eq!(EngineKind::parse("codex"), Some(EngineKind::Codex));
    assert_eq!(EngineKind::parse(" UAC\n"), Some(EngineKind::Uac));
    assert_eq!(
        EngineKind::parse("unieai-agent-core"),
        Some(EngineKind::Uac)
    );
    assert_eq!(EngineKind::parse("dsh"), None);
}

#[test]
fn engine_file_round_trips_and_defaults_to_codex() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(configured_engine(home.path()), EngineKind::Codex);
    write_engine(home.path(), EngineKind::Uac).expect("write");
    assert_eq!(configured_engine(home.path()), EngineKind::Uac);
    write_engine(home.path(), EngineKind::Codex).expect("write");
    assert_eq!(configured_engine(home.path()), EngineKind::Codex);
}

#[test]
fn uac_socket_is_distinct_from_the_daemon_socket() {
    let home = tempfile::tempdir().expect("tempdir");
    let uac = uac_socket_path(home.path());
    assert!(is_uac_socket(home.path(), &uac));
    let daemon = codex_app_server_client::app_server_control_socket_path(home.path())
        .expect("daemon socket");
    assert!(!is_uac_socket(home.path(), daemon.as_path()));
}

#[test]
fn deep_homes_get_a_short_stable_socket() {
    let deep = PathBuf::from(format!("/tmp/{}/home", "d".repeat(120)));
    let socket = uac_socket_path(&deep);
    assert!(socket.as_os_str().len() <= MAX_SOCKET_PATH_BYTES);
    assert_eq!(socket, uac_socket_path(&deep));
    assert_ne!(socket, uac_socket_path(&deep.join("other")));
    assert!(is_uac_socket(&deep, &socket));

    let shallow = PathBuf::from("/home/u/.unieai");
    assert_eq!(
        uac_socket_path(&shallow),
        PathBuf::from("/home/u/.unieai/uac/app-server.sock")
    );
}
