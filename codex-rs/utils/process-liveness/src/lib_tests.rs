use super::*;
use pretty_assertions::assert_eq;

#[cfg(unix)]
#[tokio::test]
async fn current_process_is_possibly_alive() {
    let identity = ProcessIdentity::current()
        .await
        .expect("current process identity should be readable");

    assert_eq!(identity.pid, std::process::id());
    assert!(identity.is_possibly_alive().await);
}

#[cfg(unix)]
#[tokio::test]
async fn a_reused_pid_is_rejected_by_the_start_token() {
    let mut identity = ProcessIdentity::current()
        .await
        .expect("current process identity should be readable");
    // Same live pid, different start token: exactly the shape of a recycled
    // pid, which a bare `process_exists` check would wave through.
    identity.start_token = format!("{}-stale", identity.start_token);

    assert!(!identity.is_possibly_alive().await);
}

#[cfg(unix)]
#[tokio::test]
async fn a_different_boot_is_rejected() {
    let mut identity = ProcessIdentity::current()
        .await
        .expect("current process identity should be readable");
    identity.boot_id = format!("{}-other", identity.boot_id);

    assert!(!identity.is_possibly_alive().await);
}

#[cfg(unix)]
#[tokio::test]
async fn an_exited_process_is_not_possibly_alive() {
    let mut child = tokio::process::Command::new("sh")
        .args(["-c", "exit 0"])
        .spawn()
        .expect("child should spawn");
    let pid = child.id().expect("child pid");
    let identity = match ProcessIdentity::for_pid(pid).await {
        Ok(identity) => identity,
        // The child may already have exited; a placeholder token still
        // exercises the "process is gone" path.
        Err(_) => ProcessIdentity {
            pid,
            start_token: "unreadable".to_string(),
            boot_id: boot_id().await.unwrap_or_default(),
        },
    };
    child.wait().await.expect("child should exit");

    assert!(!identity.is_possibly_alive().await);
}

#[cfg(target_os = "linux")]
#[test]
fn start_time_survives_a_comm_containing_spaces_and_parens() {
    // `comm` is unquoted, so a process named ")x (y" would break any parser
    // that splits on whitespace from the left.
    let fields: Vec<String> = (3..=22).map(|field| field.to_string()).collect();
    let stat = format!("1 ()x (y) {}", fields.join(" "));

    assert_eq!(
        platform::parse_start_time_field(&stat).expect("starttime should parse"),
        "22"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_truncated_stat_line_is_an_error_not_a_wrong_answer() {
    let stat = "1 (sh) S 0 1 1";

    assert!(platform::parse_start_time_field(stat).is_err());
}
