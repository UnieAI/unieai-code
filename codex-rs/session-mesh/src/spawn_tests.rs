use super::*;
use pretty_assertions::assert_eq;
use std::time::Duration;

fn thread_id(tail: &str) -> ThreadId {
    ThreadId::from_string(&format!("019460c8-1b2a-7c3d-8e4f-{tail}")).expect("valid thread id")
}

#[test]
fn the_child_command_carries_the_parent_link_and_detaches() {
    let log = tempfile::NamedTempFile::new().expect("temp log");
    let params = SpawnChildParams {
        prompt: "run the tests".to_string(),
        cwd: Some(std::path::PathBuf::from("/w/api")),
    };

    let command = child_command(
        std::path::Path::new("/usr/bin/unieai"),
        &params,
        "spawn-1",
        thread_id("5a6b0c0d0e0f"),
        log.reopen().expect("reopen log"),
        log.reopen().expect("reopen log"),
    );

    let args: Vec<String> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args[0], "exec");
    assert!(args.contains(&"run the tests".to_string()), "{args:?}");

    let env: Vec<(String, Option<String>)> = command
        .as_std()
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect();
    // Without these the child has no way to know who launched it, and the
    // launcher has no way to find it.
    assert!(
        env.contains(&(SPAWN_ID_ENV.to_string(), Some("spawn-1".to_string()))),
        "{env:?}"
    );
    assert!(
        env.contains(&(
            SPAWN_PARENT_ENV.to_string(),
            Some(thread_id("5a6b0c0d0e0f").to_string())
        )),
        "{env:?}"
    );
    assert_eq!(
        command.as_std().get_current_dir(),
        Some(std::path::Path::new("/w/api"))
    );
}

#[tokio::test]
async fn rendezvous_returns_the_child_once_it_registers() {
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = std::sync::Arc::clone(&attempts);

    let resolved = await_rendezvous(
        "spawn-1",
        Duration::from_secs(5),
        std::path::Path::new("/tmp/child.log"),
        move |_| {
            let seen = std::sync::Arc::clone(&seen);
            async move {
                // The child pays full CLI startup before it reaches the mesh,
                // so the first look is expected to miss.
                let attempt = seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok((attempt >= 2).then(|| thread_id("5a6b9a8b7c6d")))
            }
        },
    )
    .await
    .expect("the child should be found");

    assert_eq!(resolved, thread_id("5a6b9a8b7c6d"));
    assert!(attempts.load(std::sync::atomic::Ordering::SeqCst) >= 3);
}

#[tokio::test]
async fn a_child_that_never_registers_times_out_and_names_its_log() {
    let err = await_rendezvous(
        "spawn-1",
        Duration::from_millis(300),
        std::path::Path::new("/tmp/child-42.log"),
        |_| async { Ok(None) },
    )
    .await
    .expect_err("a child that never registers must not hang the launcher");

    // The log path is the only place a startup failure is visible, so the
    // error has to name it.
    assert!(err.to_string().contains("/tmp/child-42.log"), "{err}");
}
