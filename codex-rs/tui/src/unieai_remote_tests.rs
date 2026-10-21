// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;
use serde_json::json;

fn text(lines: &[Line<'static>]) -> String {
    lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The QR rows with dark modules drawn as ink, so a snapshot shows the code.
fn qr_text(link: &str) -> String {
    qr_rows(link)
        .expect("the link fits in a QR code")
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|cell| match cell {
                    (false, false) => ' ',
                    (true, false) => '▀',
                    (false, true) => '▄',
                    (true, true) => '█',
                })
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the uac server answers to `unieai/remote/start` (fixed secrets).
fn started() -> RemoteControlInfo {
    serde_json::from_value(json!({
        "running": true,
        "connected": true,
        "relayUrl": "https://agent.unieai.com/api/remote",
        "roomId": "r_room",
        "viewers": 0,
        "devices": 1,
        "error": null,
        "link": "https://agent.unieai.com/remote#v=1&relay=https%3A%2F%2Fagent.unieai.com%2Fapi%2Fremote&room=r_room&join=j0in&hk=aG9zdGtleWhvc3RrZXlob3N0a2V5aG9zdGtleWhv&psk=c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0&name=devbox",
        "expiresAt": "2026-10-20T12:10:00.000Z"
    }))
    .expect("the start answer parses")
}

#[test]
fn remote_control_shows_the_link_and_its_qr_code() {
    insta::assert_snapshot!(text(&remote_control_lines(&started())));
}

#[test]
fn the_qr_code_encodes_the_link_with_a_quiet_zone() {
    let info = started();
    let link = info.link.as_deref().expect("a link");
    insta::assert_snapshot!(qr_text(link));
    let rows = qr_rows(link).expect("rows");
    let width = rows[0].len();
    assert_eq!(
        (width - 2 * QUIET_ZONE - 21) % 4,
        0,
        "a QR width is 21 + 4n modules"
    );
    // The finder pattern's top edge: seven dark modules after the quiet zone.
    let top_edge: Vec<bool> = rows[QUIET_ZONE / 2][QUIET_ZONE..QUIET_ZONE + 7]
        .iter()
        .map(|cell| cell.0)
        .collect();
    assert_eq!(top_edge, vec![true; 7]);
}

#[test]
fn the_status_line_counts_viewers_only_while_remote_control_runs() {
    assert_eq!(viewers_label(0), "Remote: 0 viewers");
    assert_eq!(viewers_label(1), "Remote: 1 viewer");
    assert_eq!(viewers_label(3), "Remote: 3 viewers");

    let mut info = started();
    info.viewers = 2;
    assert!(record_status(Some(&info)));
    assert_eq!(status_segment().as_deref(), Some("Remote: 2 viewers"));
    assert!(
        !record_status(Some(&info)),
        "an unchanged count needs no redraw"
    );
    info.running = false;
    assert!(record_status(Some(&info)));
    assert_eq!(status_segment(), None);
}

#[test]
fn the_terminal_qr_code_is_dark_on_light_whatever_the_theme() {
    let ansi = qr_ansi("https://example.com/#x");
    assert!(
        ansi.contains("\x1b[30;107m▀"),
        "dark modules are drawn black on white"
    );
    assert!(ansi.lines().all(|line| line.ends_with("\x1b[0m")));
}
