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
fn engine_file_round_trips_and_defaults_to_uac() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(configured_engine(home.path()), EngineKind::Uac);
    write_engine(home.path(), EngineKind::Codex).expect("write");
    assert_eq!(configured_engine(home.path()), EngineKind::Codex);
    write_engine(home.path(), EngineKind::Uac).expect("write");
    assert_eq!(configured_engine(home.path()), EngineKind::Uac);
}

#[test]
fn uac_mode_parses_round_trips_and_defaults_to_standard() {
    assert_eq!(UacMode::parse(" PTC\n"), Some(UacMode::Ptc));
    assert_eq!(UacMode::parse("uac-minimal"), Some(UacMode::Minimal));
    assert_eq!(UacMode::parse("uac:creator"), Some(UacMode::Cordis));
    assert_eq!(UacMode::parse("codex"), None);
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(configured_uac_mode(home.path()), UacMode::Standard);
    write_uac_mode(home.path(), UacMode::Cordis).expect("write");
    assert_eq!(configured_uac_mode(home.path()), UacMode::Cordis);
    // The file the uac server reads (agent-runtime configuredUacMode).
    assert_eq!(
        std::fs::read_to_string(home.path().join("uac").join("mode")).expect("read"),
        "cordis\n"
    );
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

fn write_account(home: &std::path::Path, account: &str) {
    let json = serde_json::json!({
        "account": account,
        "studio_url": "https://agent.unieai.com",
        "access_token": "",
        "refresh_token": "",
        "expires_at": 0,
        "gateway_base_url": "https://agent.unieai.com/api/desktop/v1",
        "gateway_api_key": "k",
    });
    std::fs::write(home.join("unieai.json"), json.to_string()).expect("write unieai.json");
}

#[test]
fn rabi_accounts_cannot_run_the_codex_engine() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(engine_unavailable_reason(home.path(), EngineKind::Codex), None);
    write_account(home.path(), "studio");
    assert_eq!(engine_unavailable_reason(home.path(), EngineKind::Codex), None);

    write_account(home.path(), "rabi");
    let reason = engine_unavailable_reason(home.path(), EngineKind::Codex).expect("reason");
    assert!(reason.contains("UnieAI Rabi"), "{reason}");
    assert_eq!(engine_unavailable_reason(home.path(), EngineKind::Uac), None);
    write_engine(home.path(), EngineKind::Codex).expect("write");
    assert_eq!(resolve_engine(home.path()), EngineKind::Uac);
}

#[test]
fn a_uac_start_failure_names_the_reason_and_the_log() {
    let home = tempfile::tempdir().expect("tempdir");
    let log = uac_log_path(home.path());
    std::fs::create_dir_all(log.parent().expect("log dir")).expect("mkdir");
    std::fs::write(&log, "uac: starting\nunieai-uac-server needs Node.js 22 or newer (found v20.11.0)\n[trace] x\n").expect("write log");
    let warning = uac_unavailable_warning(home.path(), &std::io::Error::other("the uac server did not come up within 20s"));
    assert!(warning.contains("did not start"), "{warning}");
    assert!(warning.contains("within 20s"), "{warning}");
    assert!(warning.contains("needs Node.js 22 or newer"), "{warning}");
    assert!(warning.contains(&log.display().to_string()), "{warning}");
}
