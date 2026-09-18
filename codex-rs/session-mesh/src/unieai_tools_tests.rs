// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::wire::Delivery;
use pretty_assertions::assert_eq;

#[test]
fn a_held_send_reports_the_state_and_the_reason() {
    let result = SendPeerMessageResult::from(Ack {
        accepted: true,
        delivery: Delivery::Held,
        reject_reason: Some("held for approval".to_string()),
    });

    assert_eq!(
        serde_json::to_value(&result).expect("serializes"),
        json!({"accepted": true, "delivery": "held", "note": "held for approval"})
    );
}

#[test]
fn arguments_match_the_schema() {
    let args: SendPeerMessageArgs = serde_json::from_value(json!({
        "target": "api [k2f8]",
        "message": "hi",
    }))
    .expect("parses");
    assert!(!args.queue_only);
    assert!(
        serde_json::from_value::<SendPeerMessageArgs>(json!({
            "target": "api", "message": "hi", "extra": 1
        }))
        .is_err()
    );
    assert_eq!(
        send_peer_message_input_schema()["required"],
        json!(["target", "message"])
    );
}
