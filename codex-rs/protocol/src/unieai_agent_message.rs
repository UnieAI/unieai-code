// Copyright (c) 2026 UnieAI. All rights reserved.
//! Delivering `agent_message` items to providers that do not understand them.
//!
//! `{"type":"agent_message"}` is an OpenAI-backend extension to the Responses
//! API, not part of the published spec. The UnieAI gateway accepts a request
//! containing one and silently drops the item: the request succeeds, the
//! input token count shows the text never reached the model, and the model
//! answers as if nothing had been said. That made every message from a peer
//! session (and every sub-agent message) invisible to the model it was sent
//! to, with no error anywhere.
//!
//! For such providers the item is re-expressed as a user-role message carrying
//! the same text, which every Responses implementation passes through. The
//! text already says who it is from — a peer message is wrapped in a
//! `<peer-session-message>` block with a trust note — so nothing the model
//! needs is lost. Only the request is rewritten; history keeps the original
//! item.

use crate::models::AgentMessageInputContent;
use crate::models::ContentItem;
use crate::models::ResponseItem;

/// Author prefix of messages that arrive from another session on the machine.
/// Those carry their own framing, so no header is added.
const PEER_AUTHOR_PREFIX: &str = "/peer/";

/// Rewrites every `agent_message` in `items` as a user-role message.
pub fn agent_messages_as_user_messages(items: &mut [ResponseItem]) {
    for item in items.iter_mut() {
        if let Some(message) = agent_message_as_user_message(item) {
            *item = message;
        }
    }
}

/// The user-role equivalent of an `agent_message`, or `None` for any other
/// item.
///
/// Encrypted parts are dropped: a provider that does not know the item type
/// cannot decrypt its payload either.
pub fn agent_message_as_user_message(item: &ResponseItem) -> Option<ResponseItem> {
    let ResponseItem::AgentMessage {
        author,
        recipient,
        content,
        ..
    } = item
    else {
        return None;
    };

    let body = content
        .iter()
        .filter_map(|part| match part {
            AgentMessageInputContent::InputText { text } => Some(text.as_str()),
            AgentMessageInputContent::EncryptedContent { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = if author.starts_with(PEER_AUTHOR_PREFIX) {
        body
    } else {
        format!("[message from agent {author} to {recipient}]\n{body}")
    };

    // No id: the original id names an item type this provider never saw.
    Some(ResponseItem::Message {
        id: None,
        role: "user".to_string(),
        content: vec![ContentItem::InputText { text }],
        phase: None,
        internal_chat_message_metadata_passthrough: None,
    })
}

#[cfg(test)]
#[path = "unieai_agent_message_tests.rs"]
mod unieai_agent_message_tests;
