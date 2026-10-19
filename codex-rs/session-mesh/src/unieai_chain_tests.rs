// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

fn peer() -> ThreadId {
    ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f").expect("id")
}

fn other() -> ThreadId {
    ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d").expect("id")
}

fn third() -> ThreadId {
    ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b11112222").expect("id")
}

#[test]
fn a_reply_to_a_peer_goes_out_one_hop_further() {
    let chain = PeerChain::default();
    assert_eq!(chain.outbound_hop(peer()), 0);

    chain.note_delivered(peer(), 0);
    assert_eq!(chain.outbound_hop(peer()), 1);
    chain.note_delivered(peer(), 2);
    assert_eq!(chain.outbound_hop(peer()), 3);
    // A later, shorter chain does not reset the distance already travelled.
    chain.note_delivered(peer(), 1);
    assert_eq!(chain.outbound_hop(peer()), 3);
}

#[test]
fn passing_a_message_on_to_another_peer_carries_its_hop() {
    let chain = PeerChain::default();
    chain.note_delivered(peer(), 4);
    assert_eq!(chain.outbound_hop(other()), 5);

    // Long after, a message to someone else is not that request any more.
    chain.age_for_test(RELAY_WINDOW + std::time::Duration::from_secs(1));
    assert_eq!(chain.outbound_hop(other()), 0);
    assert_eq!(chain.outbound_hop(peer()), 5);
}

#[test]
fn a_new_question_from_a_session_starts_its_exchange_over() {
    // B answers A at length, then C asks B something. Measured live before
    // this: B's answer to C went out at hop 5 (A's exchange), and a session
    // that answers for others reached the hop limit after a few
    // conversations, so its answers stopped reaching anyone.
    let chain = PeerChain::new(2);
    for hop in [0, 2, 4] {
        chain.note_arrival(peer(), hop, true);
        chain.note_delivered(peer(), hop);
    }
    chain.note_turn_started(peer());
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));
    assert_eq!(chain.outbound_hop(peer()), 5);

    chain.age_for_test(RELAY_WINDOW + std::time::Duration::from_secs(1));
    chain.note_arrival(third(), 0, true);
    chain.note_delivered(third(), 0);
    assert_eq!(chain.outbound_hop(third()), 1);

    // A asks again, its own user behind it: a new exchange with A.
    chain.note_arrival(peer(), 0, true);
    chain.note_delivered(peer(), 0);
    assert_eq!(chain.outbound_hop(peer()), 1);
    assert!(chain.may_start_turn(peer()));
}

#[test]
fn a_hop_zero_message_from_a_bridge_starts_nothing_over() {
    // `unieai peers mcp` always says hop 0, so for it only the turn budget
    // stands between a looping client and this session's tokens.
    let chain = PeerChain::new(1);
    chain.note_arrival(peer(), 0, false);
    chain.note_turn_started(peer());
    chain.note_arrival(peer(), 0, false);
    assert!(!chain.may_start_turn(peer()));
    assert!(!sender_counts_hops(Some("mcp-client")));
    assert!(!sender_counts_hops(None));
    assert!(sender_counts_hops(Some("uac")));
    assert!(sender_counts_hops(Some("codex")));
}

#[test]
fn an_exchange_that_went_quiet_is_forgotten() {
    let chain = PeerChain::new(1);
    chain.note_delivered(peer(), 8);
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));

    chain.age_for_test(EXCHANGE_IDLE + std::time::Duration::from_secs(1));

    assert_eq!(chain.outbound_hop(peer()), 0);
    assert!(chain.may_start_turn(peer()));
}

#[test]
fn user_input_resets_the_hop_count_and_the_turn_budget() {
    let chain = PeerChain::new(1);
    chain.note_delivered(peer(), 2);
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));

    chain.note_user_input();

    assert_eq!(chain.outbound_hop(peer()), 0);
    assert!(chain.may_start_turn(peer()));
}

#[test]
fn a_peer_may_start_only_a_few_turns_in_a_row() {
    let chain = PeerChain::new(2);
    let other = other();

    chain.note_turn_started(peer());
    assert!(chain.may_start_turn(peer()));
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));
    // The budget is per peer.
    assert!(chain.may_start_turn(other));
}

#[test]
fn turn_starts_from_one_peer_are_paced_and_user_input_does_not_reset_the_pace() {
    let chain = PeerChain::default();
    let gap = std::time::Duration::from_secs(60);
    assert_eq!(
        chain.turn_start_delay(peer(), gap),
        std::time::Duration::ZERO
    );

    chain.note_turn_started(peer());
    chain.note_user_input();

    let delay = chain.turn_start_delay(peer(), gap);
    assert!(delay > std::time::Duration::from_secs(59), "{delay:?}");
    assert_eq!(
        chain.turn_start_delay(peer(), std::time::Duration::ZERO),
        std::time::Duration::ZERO
    );
}
