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

pub fn create_list_peers_tool() -> ToolSpec {
    ToolSpec::Function(ResponsesApiTool {
        name: "list_peers".to_string(),
        description: "List other UnieAI Code sessions running on this machine that are reachable \
right now. Each peer is returned with a handle of the form `name [ref]`; pass that handle verbatim \
to send_peer_message. Peers are separate sessions owned by their own users — they are not your \
sub-agents, you cannot interrupt them, and they may decline your messages."
            .to_string(),
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
            JsonSchema::string(Some(
                "Peer handle exactly as returned by list_peers, for example `api [k2f8]`. \
A bare name is accepted only when it matches exactly one peer; if it matches several the call \
fails and lists the candidates, because guessing would start a turn in the wrong session."
                    .to_string(),
            )),
        ),
        (
            "message".to_string(),
            JsonSchema::string(Some(
                "Message text to deliver to the peer session.".to_string(),
            )),
        ),
        (
            "queue_only".to_string(),
            JsonSchema::boolean(Some(
                "When true, the message waits for the peer's next turn instead of starting one. \
Defaults to false."
                    .to_string(),
            )),
        ),
    ]);

    ToolSpec::Function(ResponsesApiTool {
        name: "send_peer_message".to_string(),
        description: "Send a message to another UnieAI Code session on this machine. If that \
session is idle it starts a turn to handle the message; if it is busy the message waits for its \
next turn boundary. The result reports which of those actually happened — do not assume a turn \
started. The peer may also refuse or rate-limit the message."
            .to_string(),
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
