use super::*;
use pretty_assertions::assert_eq;

/// Frozen v1 wire text. These are checked in so an accidental field rename in
/// review shows up as a failing test rather than as a peer that silently stops
/// working after one side upgrades.
const V1_HELLO: &str = r#"{"v":1,"op":"hello","v_min":1,"v_max":1,"from_thread_id":"019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f","cli_version":"0.0.22"}"#;
const V1_DOORBELL: &str = r#"{"v":1,"op":"doorbell","message_id":"m-1","from_thread_id":"019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f"}"#;
const V1_ACK: &str = r#"{"v":1,"op":"ack","accepted":true,"delivery":"started_turn"}"#;

#[test]
fn v1_frames_still_deserialize() {
    assert_eq!(
        Envelope::from_line(V1_HELLO).expect("hello should parse"),
        Envelope::new(
            1,
            Body::Hello(Hello {
                v_min: 1,
                v_max: 1,
                from_thread_id: "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f".to_string(),
                cli_version: "0.0.22".to_string(),
            })
        )
    );
    assert_eq!(
        Envelope::from_line(V1_DOORBELL).expect("doorbell should parse"),
        Envelope::new(
            1,
            Body::Doorbell(Doorbell {
                message_id: "m-1".to_string(),
                from_thread_id: "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f".to_string(),
            })
        )
    );
    assert_eq!(
        Envelope::from_line(V1_ACK).expect("ack should parse"),
        Envelope::new(
            1,
            Body::Ack(Ack {
                accepted: true,
                delivery: Delivery::StartedTurn,
                reject_reason: None,
            })
        )
    );
}

#[test]
fn a_frame_round_trips_through_one_line() {
    let envelope = Envelope::new(
        1,
        Body::Doorbell(Doorbell {
            message_id: "m-1".to_string(),
            from_thread_id: "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f".to_string(),
        }),
    );

    let line = envelope.to_line().expect("frame should serialize");

    assert!(line.ends_with('\n'), "frames must be newline-delimited");
    assert_eq!(line.matches('\n').count(), 1, "one frame per line");
    assert_eq!(
        Envelope::from_line(&line).expect("frame should round trip"),
        envelope
    );
}

#[test]
fn an_unknown_field_from_a_newer_peer_is_ignored() {
    // Additive data must not break an older peer, or no field could ever be
    // added without a flag day.
    let line =
        r#"{"v":1,"op":"doorbell","message_id":"m-1","from_thread_id":"t","priority":"high"}"#;

    let envelope = Envelope::from_line(line).expect("unknown fields should be ignored");

    assert!(matches!(envelope.body, Body::Doorbell(_)));
}

#[test]
fn an_unknown_operation_parses_so_it_can_be_refused_out_loud() {
    // The whole point: an operation this build does not implement must be
    // *recognisable* so we can answer `unsupported_op`, rather than failing to
    // parse and vanishing without either side noticing.
    let line = r#"{"v":2,"op":"future_thing","payload":{"anything":1}}"#;

    let envelope = Envelope::from_line(line).expect("unknown ops must still parse");

    assert_eq!(envelope.v, 2);
    assert_eq!(envelope.body, Body::Unknown);
}

#[test]
fn an_unknown_error_code_from_a_newer_peer_is_still_reportable() {
    let line = r#"{"v":1,"op":"error","code":"quota_exhausted","message":"nope"}"#;

    let envelope = Envelope::from_line(line).expect("unknown codes should parse");

    let Body::Error(error) = envelope.body else {
        panic!("expected an error frame");
    };
    assert_eq!(error.code, ErrorCode::Unknown);
    // The human-readable half survives, so the user is told *something*.
    assert_eq!(error.message, "nope");
}

#[test]
fn malformed_json_is_an_error_not_a_silent_drop() {
    assert!(Envelope::from_line("{not json").is_err());
}

#[test]
fn version_negotiation_picks_the_highest_shared_version() {
    assert_eq!(negotiate_version(1, 3, 2, 5), Some(3));
    assert_eq!(negotiate_version(1, 1, 1, 1), Some(1));
    // Disjoint ranges must fail explicitly rather than fall back to a version
    // one side cannot actually speak.
    assert_eq!(negotiate_version(3, 4, 1, 2), None);
    assert_eq!(negotiate_version(1, 2, 3, 4), None);
}

#[test]
fn probe_status_maps_unknown_strings_to_unknown() {
    for (status, expected) in [
        ("idle", PeerStatus::Idle),
        ("working", PeerStatus::Working),
        ("meditating", PeerStatus::Unknown),
    ] {
        let probe = ProbeOk {
            status: status.to_string(),
            cli_version: "0.0.22".to_string(),
        };
        assert_eq!(probe.peer_status(), expected);
    }
}
