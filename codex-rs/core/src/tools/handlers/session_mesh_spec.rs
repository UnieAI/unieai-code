//! Tool specs for the machine-local session mesh.
//!
//! Kept separate from the sub-agent tools on purpose. A sub-agent is yours: you
//! spawned it, it spends your budget, and you can interrupt it. A peer is
//! somebody else's session — it can decline you, it can be running a different
//! build, and it can vanish mid-conversation. Collapsing the two into one tool
//! would produce a surface whose failure modes are the union of both, and a
//! model that cannot tell which kind of thing it is addressing.

use codex_tools::JsonSchema;
use codex_tools::ResponsesApiTool;
use codex_tools::ToolSpec;
use std::collections::BTreeMap;
use unieai_session_mesh::unieai_tools;

pub fn create_list_peers_tool() -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: "list_peers".to_string(),
        description: unieai_tools::LIST_PEERS_DESCRIPTION.to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(BTreeMap::new(), /*required*/ None, Some(false.into())),
        output_schema: None,
    })
}

pub fn create_send_peer_message_tool() -> ToolSpec {
    let properties = BTreeMap::from([
        (
            "target".to_string(),
            JsonSchema::string(Some(unieai_tools::TARGET_DESCRIPTION.to_string())),
        ),
        (
            "message".to_string(),
            JsonSchema::string(Some(unieai_tools::MESSAGE_DESCRIPTION.to_string())),
        ),
        (
            "queue_only".to_string(),
            JsonSchema::boolean(Some(unieai_tools::QUEUE_ONLY_DESCRIPTION.to_string())),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "send_peer_message".to_string(),
        description: unieai_tools::SEND_PEER_MESSAGE_DESCRIPTION.to_string(),
        strict: false,
        defer_loading: None,
        parameters: JsonSchema::object(
            properties,
            Some(vec!["target".to_string(), "message".to_string()]),
            Some(false.into()),
        ),
        output_schema: None,
    })
}
