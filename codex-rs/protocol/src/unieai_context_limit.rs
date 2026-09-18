// Copyright (c) 2026 UnieAI. All rights reserved.
//! Reading the context window a gateway states when it rejects a request.
//!
//! Lives here because both the SSE parser (`codex-api`) and the model
//! metadata layer (`codex-models-manager`, which stores what was learned)
//! need it, and only this crate is below both.

/// Below this a "limit" is a parse accident, not a context window.
pub const MIN_PLAUSIBLE_LIMIT: i64 = 4_000;

/// The real context window stated by a rejection, if the message states one.
///
/// Recognizes the two shapes gateways use:
///   "The input (131123 tokens) is longer than the model's context length (131072 tokens)"
///   "This model's maximum context length is 128000 tokens, however you requested ..."
pub fn parse_context_limit(message: &str) -> Option<i64> {
    let lowered = message.to_ascii_lowercase();
    let after = ["context length", "context window", "context_length"]
        .iter()
        .find_map(|needle| lowered.find(needle).map(|index| index + needle.len()))?;
    first_integer(&lowered[after..]).filter(|limit| *limit >= MIN_PLAUSIBLE_LIMIT)
}

/// The first integer in `text`, ignoring digit group separators.
fn first_integer(text: &str) -> Option<i64> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let mut digits = String::new();
    for c in text[start..].chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else if (c == ',' || c == '_') && !digits.is_empty() {
            continue;
        } else {
            break;
        }
    }
    digits.parse().ok()
}


#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn reads_the_limit_a_gateway_states() {
        assert_eq!(
            parse_context_limit(
                "The input (131123 tokens) is longer than the model's context length (131072 tokens)."
            ),
            Some(131_072)
        );
        assert_eq!(
            parse_context_limit("This model's maximum context length is 128,000 tokens, however ..."),
            Some(128_000)
        );
        assert_eq!(parse_context_limit("rate limit reached"), None);
        assert_eq!(parse_context_limit("context length (12 tokens)"), None);
    }
}
