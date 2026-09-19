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
    assert_eq!(
        engine_unavailable_reason(home.path(), EngineKind::Codex),
        None
    );
    write_account(home.path(), "studio");
    assert_eq!(
        engine_unavailable_reason(home.path(), EngineKind::Codex),
        None
    );

    write_account(home.path(), "rabi");
    let reason = engine_unavailable_reason(home.path(), EngineKind::Codex).expect("reason");
    assert!(reason.contains("UnieAI Rabi"), "{reason}");
    assert_eq!(
        engine_unavailable_reason(home.path(), EngineKind::Uac),
        None
    );
    write_engine(home.path(), EngineKind::Codex).expect("write");
    assert_eq!(resolve_engine(home.path()), EngineKind::Uac);
}

#[test]
fn a_uac_start_failure_names_the_reason_and_the_log() {
    let home = tempfile::tempdir().expect("tempdir");
    let log = uac_log_path(home.path());
    std::fs::create_dir_all(log.parent().expect("log dir")).expect("mkdir");
    std::fs::write(
        &log,
        "uac: starting\nunieai-uac-server needs Node.js 22 or newer (found v20.11.0)\n[trace] x\n",
    )
    .expect("write log");
    let warning = uac_unavailable_warning(
        home.path(),
        &std::io::Error::other("the uac server did not come up within 20s"),
    );
    assert!(warning.contains("did not start"), "{warning}");
    assert!(warning.contains("within 20s"), "{warning}");
    assert!(warning.contains("needs Node.js 22 or newer"), "{warning}");
    assert!(warning.contains(&log.display().to_string()), "{warning}");
}

#[test]
fn unieai_provider_without_a_sign_in_needs_one() {
    let home = tempfile::tempdir().expect("tempdir");
    // SAFETY: tests in this module do not read UNIEAI_API_KEY concurrently.
    let saved = std::env::var_os("UNIEAI_API_KEY");
    unsafe { std::env::remove_var("UNIEAI_API_KEY") };
    assert!(needs_unieai_sign_in("unieai", home.path()));
    assert!(
        !needs_unieai_sign_in("openai", home.path()),
        "other providers keep their own login check"
    );
    unsafe { std::env::set_var("UNIEAI_API_KEY", "k") };
    assert!(
        !needs_unieai_sign_in("unieai", home.path()),
        "an API key is enough"
    );
    match saved {
        Some(value) => unsafe { std::env::set_var("UNIEAI_API_KEY", value) },
        None => unsafe { std::env::remove_var("UNIEAI_API_KEY") },
    }
}

#[test]
fn node_versions_parse_to_their_major() {
    assert_eq!(parse_node_major("v22.21.1\n"), Some(22));
    assert_eq!(parse_node_major("v20.19.5"), Some(20));
    assert_eq!(parse_node_major("not node"), None);
}

#[test]
fn version_manager_installs_are_searched() {
    let home = tempfile::tempdir().expect("tempdir");
    std::fs::create_dir_all(home.path().join(".nvm/versions/node/v22.21.1/bin")).expect("mkdir");
    let candidates = node_candidates(Some(home.path()));
    assert!(candidates.contains(&home.path().join(".nvm/versions/node/v22.21.1/bin/node")));
}

#[test]
fn an_old_node_gets_install_advice() {
    let home = tempfile::tempdir().expect("tempdir");
    let warning =
        uac_unavailable_warning(home.path(), &node_too_old(Some(20), /*unieai_node*/ None));
    assert_eq!(
        warning,
        "unieai-agent-core (uac), the default engine, needs Node.js 22 or newer; the node on PATH is Node 20, \
         so this session runs on codex. Install Node.js 22 (for example `nvm install 22` or `brew install node@22`) \
         and restart UnieAI Code; if Node 22 is installed somewhere unusual, set UNIEAI_NODE to its path."
    );
}

#[test]
fn a_server_started_by_another_release_does_not_count_as_ours() {
    let ours = UacServerStamp {
        pid: Some(42),
        cli_version: Some(crate::version::CODEX_CLI_VERSION.to_string()),
    };
    let older = UacServerStamp {
        pid: Some(42),
        cli_version: Some("0.0.1".to_string()),
    };
    let unknown = UacServerStamp {
        pid: Some(42),
        cli_version: None,
    };
    assert!(stamp_matches_this_release(Some(&ours)));
    assert!(!stamp_matches_this_release(Some(&older)));
    assert!(!stamp_matches_this_release(Some(&unknown)));
    assert!(!stamp_matches_this_release(None));
}

#[test]
fn the_stamp_is_read_from_beside_the_socket() {
    let dir = tempfile::tempdir().expect("tempdir");
    let socket = dir.path().join("app-server.sock");
    assert!(server_stamp(&socket).is_none());
    std::fs::write(
        dir.path().join("app-server.sock.json"),
        br#"{"pid":4321,"cliVersion":"0.0.29","engineVersion":"0.5.0"}"#,
    )
    .expect("write stamp");
    let stamp = server_stamp(&socket).expect("a stamp");
    assert_eq!(
        (stamp.pid, stamp.cli_version.as_deref()),
        (Some(4321), Some("0.0.29"))
    );
}
