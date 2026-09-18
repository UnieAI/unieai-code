// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

fn agent_message(author: &str, parts: Vec<AgentMessageInputContent>) -> ResponseItem {
    ResponseItem::AgentMessage {
        id: None,
        author: author.to_string(),
        recipient: "/root".to_string(),
        content: parts,
        internal_chat_message_metadata_passthrough: None,
    }
}

fn text(text: &str) -> AgentMessageInputContent {
    AgentMessageInputContent::InputText {
        text: text.to_string(),
    }
}

#[test]
fn a_peer_message_becomes_a_user_message_with_its_framing_untouched() {
    let framed = "<peer-session-message from=\"api\">hi</peer-session-message>";
    let converted = agent_message_as_user_message(&agent_message("/peer/k2f8", vec![text(framed)]))
        .expect("agent messages convert");

    assert_eq!(
        serde_json::to_value(&converted).expect("serializes"),
        serde_json::json!({
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": framed}],
        })
    );
}

#[test]
fn a_sub_agent_message_is_labelled_with_its_author() {
    let converted = agent_message_as_user_message(&agent_message(
        "/root/worker",
        vec![
            text("done"),
            AgentMessageInputContent::EncryptedContent {
                encrypted_content: "opaque".to_string(),
            },
        ],
    ))
    .expect("agent messages convert");

    let ResponseItem::Message { role, content, .. } = converted else {
        panic!("expected a message");
    };
    assert_eq!(role, "user");
    assert_eq!(
        content,
        vec![ContentItem::InputText {
            text: "[message from agent /root/worker to /root]\ndone".to_string()
        }]
    );
}

#[test]
fn other_items_are_left_alone() {
    let mut items = vec![
        ResponseItem::Message {
            id: None,
            role: "user".to_string(),
            content: vec![ContentItem::InputText {
                text: "hello".to_string(),
            }],
            phase: None,
            internal_chat_message_metadata_passthrough: None,
        },
        agent_message("/peer/k2f8", vec![text("from a peer")]),
    ];
    let first = items[0].clone();

    agent_messages_as_user_messages(&mut items);

    assert_eq!(items[0], first);
    assert!(matches!(
        &items[1],
        ResponseItem::Message { role, .. } if role == "user"
    ));
}
