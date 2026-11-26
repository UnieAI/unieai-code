//! Recognize the desktop's existing async-question reply envelope for display and dismissal.
//! Only complete envelopes, optionally following the standard IDE context prefix, are interpreted.

use codex_app_server_protocol::UserInput;
use codex_context_fragments::AnsweredQuestion;
use codex_context_fragments::ContextualUserFragment;
use itertools::Itertools;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AsyncQuestionReply {
    pub(crate) question_item_id: String,
    pub(crate) question: String,
    pub(crate) answer: String,
}

pub(crate) fn parse(text: &str) -> Option<Vec<AsyncQuestionReply>> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Replies {
        Many(Vec<AsyncQuestionReply>),
        One(AsyncQuestionReply),
    }
    let text = text.trim();
    // JSON strings escape newlines, so this cannot match a delimiter inside an answer.
    let text = if text.starts_with("# Context from my IDE setup:\n") {
        // This client writes its own product name (ide_context::prompt);
        // replies from other clients (the desktop app) still say Codex.
        [crate::ide_context::PROMPT_REQUEST_BEGIN, "## My request for Codex:"]
            .into_iter()
            .filter_map(|marker| text.rsplit_once(format!("\n{marker}\n").as_str()))
            .min_by_key(|(_, request)| request.len())?
            .1
            .trim()
    } else {
        text
    };
    let (start, end) = AnsweredQuestion::type_markers();
    let json = text.strip_prefix(start)?.strip_suffix(end)?;
    let replies = match serde_json::from_str::<Replies>(json).ok()? {
        Replies::Many(replies) => replies,
        Replies::One(reply) => vec![reply],
    };
    (!replies.is_empty()).then_some(replies)
}

pub(crate) fn display_text(text: &str) -> Option<String> {
    Some(display_replies(&parse(text)?))
}

pub(crate) fn display_replies(replies: &[AsyncQuestionReply]) -> String {
    replies
        .iter()
        .map(|reply| format!("> {}\n\n{}", reply.question, reply.answer))
        .join("\n\n")
}

pub(crate) fn parse_input(input: &[UserInput]) -> Option<Vec<AsyncQuestionReply>> {
    let mut content = input
        .iter()
        .filter(|item| !matches!(item, UserInput::Skill { .. } | UserInput::Mention { .. }));
    let UserInput::Text { text, .. } = content.next()? else {
        return None;
    };
    if content.next().is_some() {
        return None;
    }
    parse(text)
}

#[cfg(test)]
#[path = "async_question_reply_tests.rs"]
mod tests;
