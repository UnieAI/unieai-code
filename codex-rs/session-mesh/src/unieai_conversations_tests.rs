// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;

fn ids() -> (ThreadId, ThreadId, ThreadId) {
    (ThreadId::new(), ThreadId::new(), ThreadId::new())
}

#[test]
fn an_answer_from_the_addressed_peer_is_a_reply() {
    let (me, peer, _) = ids();
    note_sent(me, peer, /*hop*/ 0);

    assert!(is_reply_to_started(
        me, peer, /*hop*/ 1, /*max_hops*/ 10
    ));
    assert!(is_reply_to_started(
        me, peer, /*hop*/ 3, /*max_hops*/ 10
    ));
}

#[test]
fn only_the_addressed_peer_and_only_the_starter_qualify() {
    let (me, peer, stranger) = ids();
    note_sent(me, peer, /*hop*/ 0);

    assert!(!is_reply_to_started(
        me, stranger, /*hop*/ 1, /*max_hops*/ 10
    ));
    // The addressee did not start anything with `me`.
    assert!(!is_reply_to_started(
        peer, me, /*hop*/ 1, /*max_hops*/ 10
    ));
}

#[test]
fn replying_to_a_conversation_the_peer_started_does_not_count() {
    let (me, peer, _) = ids();
    // `me` answering the peer goes out one hop further, so it is a reply,
    // not the start of a conversation.
    note_sent(me, peer, /*hop*/ 1);

    assert!(!is_reply_to_started(
        me, peer, /*hop*/ 2, /*max_hops*/ 10
    ));
}

#[test]
fn an_unprompted_message_or_one_at_the_hop_limit_is_not_a_reply() {
    let (me, peer, _) = ids();
    note_sent(me, peer, /*hop*/ 0);

    assert!(!is_reply_to_started(
        me, peer, /*hop*/ 0, /*max_hops*/ 10
    ));
    assert!(!is_reply_to_started(
        me, peer, /*hop*/ 10, /*max_hops*/ 10
    ));
}
