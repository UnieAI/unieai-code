use super::*;
use pretty_assertions::assert_eq;

fn peer(uuid: &str, display_name: Option<&str>, cwd: &str) -> PeerHandle {
    let thread_id = ThreadId::from_string(uuid).expect("valid thread id");
    PeerHandle {
        thread_id,
        short_ref: short_ref_for(thread_id),
        display_name: display_name.map(str::to_string),
        cwd: PathBuf::from(cwd),
        status: PeerStatus::Idle,
    }
}

#[test]
fn short_refs_are_stable_and_use_the_unambiguous_alphabet() {
    let thread_id =
        ThreadId::from_string("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f").expect("valid thread id");

    let short_ref = short_ref_for(thread_id);

    assert_eq!(short_ref.len(), 8);
    assert_eq!(short_ref, short_ref_for(thread_id), "must be deterministic");
    // `i`, `l`, `o`, and `u` are excluded so a ref cannot be misread as another.
    assert!(
        !short_ref.contains(['i', 'l', 'o', 'u']),
        "unexpected ambiguous character in {short_ref}"
    );
}

#[test]
fn an_unnamed_session_is_still_addressable_by_its_directory() {
    let unnamed = peer(
        "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
        None,
        "/home/u/My Api",
    );

    assert_eq!(unnamed.name(), "my-api");
}

#[test]
fn names_compare_equal_across_punctuation_differences() {
    let named = peer(
        "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
        Some("My API!"),
        "/tmp",
    );

    assert_eq!(named.name(), "my-api");
    assert_eq!(
        resolve_peer(&PeerSelector::new("my api"), std::slice::from_ref(&named))
            .expect("punctuation should not defeat matching")
            .thread_id,
        named.thread_id
    );
}

#[test]
fn selector_forms_are_classified_without_a_peer_list() {
    assert!(matches!(
        PeerSelector::new("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f").form(),
        SelectorForm::ThreadId(_)
    ));
    assert_eq!(
        PeerSelector::new("api [k2f8]").form(),
        SelectorForm::NameAndRef {
            name: "api".to_string(),
            short_ref: "k2f8".to_string(),
        }
    );
    assert_eq!(
        PeerSelector::new("k2f8").form(),
        SelectorForm::ShortRef("k2f8".to_string())
    );
    // `oops` contains `o`, which is not in the alphabet, so it can only be a
    // name. This is why the alphabet excludes those letters.
    assert_eq!(
        PeerSelector::new("oops").form(),
        SelectorForm::Name("oops".to_string())
    );
}

#[test]
fn a_unique_name_resolves() {
    let peers = [
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
            Some("api"),
            "/w/api",
        ),
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d",
            Some("web"),
            "/w/web",
        ),
    ];

    let resolved = resolve_peer(&PeerSelector::new("api"), &peers).expect("unique name resolves");

    assert_eq!(resolved.thread_id, peers[0].thread_id);
}

#[test]
fn a_duplicate_name_is_a_hard_error_listing_every_candidate() {
    let peers = [
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
            Some("api"),
            "/w/api",
        ),
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d",
            Some("api"),
            "/s/api2",
        ),
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b4455667f",
            Some("api"),
            "/t/api3",
        ),
    ];

    let err = resolve_peer(&PeerSelector::new("api"), &peers)
        .expect_err("an ambiguous name must never be guessed");

    let MeshError::PeerAmbiguous(message) = err else {
        panic!("expected an ambiguity error, got {err:?}");
    };
    assert!(message.contains("matched 3 sessions"), "{message}");
    for peer in &peers {
        // Every candidate must appear in the exact form that would resolve it,
        // otherwise the message is not actionable on its own.
        assert!(
            message.contains(&peer.display_handle(short_ref_display_len(&peers))),
            "{message} is missing a candidate handle"
        );
        assert!(
            message.contains(&peer.cwd.display().to_string()),
            "{message}"
        );
    }
}

#[test]
fn the_bracketed_form_disambiguates_a_duplicate_name() {
    let peers = [
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
            Some("api"),
            "/w/api",
        ),
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d",
            Some("api"),
            "/s/api2",
        ),
    ];
    let handle = peers[1].display_handle(short_ref_display_len(&peers));

    let resolved =
        resolve_peer(&PeerSelector::new(handle), &peers).expect("bracketed form should resolve");

    assert_eq!(resolved.thread_id, peers[1].thread_id);
}

#[test]
fn a_bracketed_form_whose_halves_disagree_resolves_to_nothing() {
    let peers = [
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
            Some("api"),
            "/w/api",
        ),
        peer(
            "019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d",
            Some("web"),
            "/w/web",
        ),
    ];
    // The ref belongs to `web`, so pairing it with `api` names no session.
    // Silently honouring one half would start a turn in the wrong place.
    let mismatched = format!("api [{}]", &peers[1].short_ref[..4]);

    let err = resolve_peer(&PeerSelector::new(mismatched), &peers)
        .expect_err("halves that disagree must not resolve");

    assert!(matches!(err, MeshError::PeerNotFound { .. }), "{err:?}");
}

#[test]
fn a_full_thread_id_resolves_as_an_escape_hatch() {
    let peers = [peer(
        "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
        Some("api"),
        "/w/api",
    )];

    let resolved = resolve_peer(
        &PeerSelector::new("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f"),
        &peers,
    )
    .expect("a full uuid should resolve");

    assert_eq!(resolved.thread_id, peers[0].thread_id);
}

#[test]
fn an_unknown_selector_reports_not_found() {
    let peers = [peer(
        "019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f",
        Some("api"),
        "/w/api",
    )];

    let err = resolve_peer(&PeerSelector::new("nope"), &peers).expect_err("no such peer");

    assert!(matches!(err, MeshError::PeerNotFound { .. }), "{err:?}");
}

#[test]
fn display_length_grows_only_as_far_as_collisions_require() {
    let distinct = [
        peer("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f", Some("a"), "/a"),
        peer("019460c8-1b2a-7c3d-8e4f-5a6b9a8b7c6d", Some("b"), "/b"),
    ];
    assert_eq!(short_ref_display_len(&distinct), SHORT_REF_MIN_LEN);

    // Two ids sharing their low 40 bits collide at every prefix length, so the
    // full ref is the only honest thing to show.
    let colliding = [
        peer("019460c8-1b2a-7c3d-8e4f-5a6b0c0d0e0f", Some("a"), "/a"),
        peer("019460c8-1b2a-7c3d-9e4f-5a6b0c0d0e0f", Some("b"), "/b"),
    ];
    assert_eq!(colliding[0].short_ref, colliding[1].short_ref);
    assert_eq!(short_ref_display_len(&colliding), 8);
}
