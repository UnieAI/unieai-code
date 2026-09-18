// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;

fn peer() -> ThreadId {
    ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f").expect("id")
}

#[test]
fn a_reply_to_a_peer_goes_out_one_hop_further() {
    let chain = PeerChain::default();
    assert_eq!(chain.outbound_hop(), 0);

    chain.note_delivered(0);
    assert_eq!(chain.outbound_hop(), 1);
    chain.note_delivered(2);
    assert_eq!(chain.outbound_hop(), 3);
    // A later, shorter chain does not reset the distance already travelled.
    chain.note_delivered(1);
    assert_eq!(chain.outbound_hop(), 3);
}

#[test]
fn user_input_resets_the_hop_count_and_the_turn_budget() {
    let chain = PeerChain::new(1);
    chain.note_delivered(2);
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));

    chain.note_user_input();

    assert_eq!(chain.outbound_hop(), 0);
    assert!(chain.may_start_turn(peer()));
}

#[test]
fn a_peer_may_start_only_a_few_turns_in_a_row() {
    let chain = PeerChain::new(2);
    let other = ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d").expect("id");

    chain.note_turn_started(peer());
    assert!(chain.may_start_turn(peer()));
    chain.note_turn_started(peer());
    assert!(!chain.may_start_turn(peer()));
    // The budget is per peer.
    assert!(chain.may_start_turn(other));
}
