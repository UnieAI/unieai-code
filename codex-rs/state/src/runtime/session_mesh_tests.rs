use super::*;
use crate::runtime::test_support::test_thread_metadata;
use crate::runtime::test_support::unique_temp_dir;
use pretty_assertions::assert_eq;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

fn peer_record(thread_id: ThreadId, short_ref: &str) -> SessionMeshPeerRecord {
    SessionMeshPeerRecord {
        thread_id,
        short_ref: short_ref.to_string(),
        pid: 4123,
        process_start_token: "linux:99".to_string(),
        boot_id: "boot-a".to_string(),
        socket_path: format!("/tmp/session-mesh/{thread_id}.sock"),
        cwd: "/w/api".to_string(),
        session_source: "cli".to_string(),
        cli_version: "0.0.22".to_string(),
        protocol_min: 1,
        protocol_max: 1,
        joined_at_ms: 1_700_000_000_000,
        spawn_id: None,
        spawned_by_thread_id: None,
    }
}

fn message_record(from: ThreadId, to: ThreadId, id: &str) -> SessionMeshMessageRecord {
    SessionMeshMessageRecord {
        message_id: id.to_string(),
        from_thread_id: from,
        to_thread_id: to,
        content: "reply with the word pineapple".to_string(),
        hop: 0,
        trigger_turn: true,
        created_at_ms: 1_700_000_000_000,
        delivered_at_ms: None,
        delivery: None,
    }
}

#[tokio::test]
async fn a_peer_round_trips_and_rejoining_replaces_the_row() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let id = thread_id("5a6b0c0d0e0f");

    runtime
        .upsert_session_mesh_peer(&peer_record(id, "ddy8v7gf"))
        .await?;
    // A session that resumes reuses its thread id, so joining twice must
    // refresh the row rather than fail or duplicate it.
    let mut rejoined = peer_record(id, "ddy8v7gf");
    rejoined.pid = 5555;
    rejoined.process_start_token = "linux:100".to_string();
    runtime.upsert_session_mesh_peer(&rejoined).await?;

    let peers = runtime.list_session_mesh_peers().await?;

    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].peer.pid, 5555);
    assert_eq!(peers[0].peer.process_start_token, "linux:100");
    Ok(())
}

#[tokio::test]
async fn two_peers_may_share_a_short_ref() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;

    // A short-ref collision must surface later as an ambiguous selector. If the
    // column were UNIQUE this insert would fail and silently keep a session off
    // the mesh entirely.
    runtime
        .upsert_session_mesh_peer(&peer_record(thread_id("5a6b0c0d0e0f"), "ddy8v7gf"))
        .await?;
    runtime
        .upsert_session_mesh_peer(&peer_record(thread_id("5a6b9a8b7c6d"), "ddy8v7gf"))
        .await?;

    assert_eq!(runtime.list_session_mesh_peers().await?.len(), 2);
    Ok(())
}

#[tokio::test]
async fn leaving_the_mesh_removes_the_row() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let id = thread_id("5a6b0c0d0e0f");
    runtime
        .upsert_session_mesh_peer(&peer_record(id, "ddy8v7gf"))
        .await?;

    assert!(runtime.delete_session_mesh_peer(id).await?);
    assert!(runtime.list_session_mesh_peers().await?.is_empty());
    // Deleting an absent peer is not an error; a crashed session's row may
    // already have been reaped by whoever noticed first.
    assert!(!runtime.delete_session_mesh_peer(id).await?);
    Ok(())
}

#[tokio::test]
async fn a_peer_listing_carries_the_rename_name() -> anyhow::Result<()> {
    let codex_home = unique_temp_dir();
    let runtime = StateRuntime::init(codex_home.clone(), "test-provider".to_string()).await?;
    let id = thread_id("5a6b0c0d0e0f");
    runtime
        .upsert_thread(&test_thread_metadata(
            codex_home.as_path(),
            id,
            "/w/api".into(),
        ))
        .await?;
    runtime
        .upsert_session_mesh_peer(&peer_record(id, "ddy8v7gf"))
        .await?;

    // The name is joined rather than copied, so `/rename` takes effect with no
    // sync step and no chance of the two drifting.
    runtime.update_thread_name(id, Some("api")).await?;

    let peers = runtime.list_session_mesh_peers().await?;
    assert_eq!(peers[0].display_name.as_deref(), Some("api"));
    Ok(())
}

#[tokio::test]
async fn a_peer_without_a_thread_row_still_lists() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;

    // The join is a LEFT JOIN on purpose: a session that has not yet persisted
    // its thread row must still be discoverable, just unnamed.
    runtime
        .upsert_session_mesh_peer(&peer_record(thread_id("5a6b0c0d0e0f"), "ddy8v7gf"))
        .await?;

    let peers = runtime.list_session_mesh_peers().await?;
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].display_name, None);
    Ok(())
}

#[tokio::test]
async fn a_message_round_trips_and_records_its_delivery() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let from = thread_id("5a6b0c0d0e0f");
    let to = thread_id("5a6b9a8b7c6d");
    runtime
        .enqueue_session_mesh_message(&message_record(from, to, "m-1"))
        .await?;

    let stored = runtime
        .get_session_mesh_message("m-1")
        .await?
        .expect("message should be stored");
    assert_eq!(stored.content, "reply with the word pineapple");
    assert!(stored.trigger_turn);
    assert_eq!(stored.delivery, None);

    assert!(
        runtime
            .mark_session_mesh_message_delivered("m-1", 1_700_000_001_000, "started_turn")
            .await?
    );
    let delivered = runtime
        .get_session_mesh_message("m-1")
        .await?
        .expect("message should still be stored");
    assert_eq!(delivered.delivery.as_deref(), Some("started_turn"));
    assert_eq!(delivered.delivered_at_ms, Some(1_700_000_001_000));
    Ok(())
}

#[tokio::test]
async fn the_inbox_returns_only_messages_addressed_here_and_newer_than_the_watermark()
-> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let me = thread_id("5a6b0c0d0e0f");
    let peer = thread_id("5a6b9a8b7c6d");
    let stranger = thread_id("5a6b4455667f");

    for (id, to, created_at_ms) in [
        ("m-old", me, 1_000),
        ("m-new", me, 3_000),
        ("m-elsewhere", stranger, 3_000),
    ] {
        let mut message = message_record(peer, to, id);
        message.created_at_ms = created_at_ms;
        runtime.enqueue_session_mesh_message(&message).await?;
    }

    let inbox = runtime.list_session_mesh_messages_for(me, 2_000).await?;

    assert_eq!(
        inbox
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<Vec<_>>(),
        vec!["m-new"]
    );
    Ok(())
}

#[tokio::test]
async fn only_delivered_turn_starts_count_toward_the_rate_limit() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let from = thread_id("5a6b0c0d0e0f");
    let to = thread_id("5a6b9a8b7c6d");

    // Counted: a turn actually started.
    let mut started = message_record(from, to, "m-started");
    started.delivered_at_ms = Some(5_000);
    started.delivery = Some("started_turn".to_string());
    runtime.enqueue_session_mesh_message(&started).await?;

    // Not counted: queued rather than started, so it cost the recipient
    // nothing and must not consume their budget.
    let mut queued = message_record(from, to, "m-queued");
    queued.delivered_at_ms = Some(5_000);
    queued.delivery = Some("queued".to_string());
    runtime.enqueue_session_mesh_message(&queued).await?;

    // Not counted: older than the window.
    let mut old = message_record(from, to, "m-old");
    old.delivered_at_ms = Some(100);
    old.delivery = Some("started_turn".to_string());
    runtime.enqueue_session_mesh_message(&old).await?;

    assert_eq!(
        runtime
            .count_recent_session_mesh_triggers(from, to, 1_000)
            .await?,
        1
    );
    Ok(())
}

#[tokio::test]
async fn a_launcher_finds_its_child_by_spawn_id() -> anyhow::Result<()> {
    let runtime = StateRuntime::init(unique_temp_dir(), "test-provider".to_string()).await?;
    let parent = thread_id("5a6b0c0d0e0f");
    let child = thread_id("5a6b9a8b7c6d");

    // The launcher cannot know the child's thread id in advance — the child
    // mints it — so it looks the child up by the token it passed in.
    let mut child_row = peer_record(child, "aaaaaaaa");
    child_row.spawn_id = Some("spawn-1".to_string());
    child_row.spawned_by_thread_id = Some(parent);
    runtime.upsert_session_mesh_peer(&child_row).await?;
    runtime
        .upsert_session_mesh_peer(&peer_record(parent, "bbbbbbbb"))
        .await?;

    assert_eq!(
        runtime
            .find_session_mesh_peer_by_spawn_id("spawn-1")
            .await?,
        Some(child)
    );
    // An unknown token must report "not yet" rather than matching something.
    assert_eq!(
        runtime
            .find_session_mesh_peer_by_spawn_id("spawn-2")
            .await?,
        None
    );

    let peers = runtime.list_session_mesh_peers().await?;
    let listed_child = peers
        .iter()
        .find(|peer| peer.peer.thread_id == child)
        .expect("child should be listed");
    assert_eq!(listed_child.peer.spawned_by_thread_id, Some(parent));
    Ok(())
}
