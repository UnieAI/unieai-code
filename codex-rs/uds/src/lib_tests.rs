use std::io::ErrorKind;

use pretty_assertions::assert_eq;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use super::*;

#[tokio::test]
async fn prepare_private_socket_directory_creates_directory() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_dir = temp_dir.path().join("app-server-control");

    prepare_private_socket_directory(&socket_dir)
        .await
        .expect("socket dir should be created");

    assert!(socket_dir.is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_private_socket_directory_sets_existing_permissions_to_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    for mode in [0o755, 0o600] {
        let socket_dir = temp_dir.path().join(format!("app-server-control-{mode:o}"));
        std::fs::create_dir(&socket_dir).expect("socket dir should be created");
        std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(mode))
            .expect("socket dir permissions should be changed");

        prepare_private_socket_directory(&socket_dir)
            .await
            .expect("socket dir permissions should be set exactly");

        let mode = std::fs::metadata(&socket_dir)
            .expect("socket dir metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn regular_file_path_is_not_stale_socket_path() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let regular_file = temp_dir.path().join("not-a-socket");
    std::fs::write(&regular_file, b"not a socket").expect("regular file should be created");

    assert!(
        !is_stale_socket_path(&regular_file)
            .await
            .expect("stale socket check should succeed")
    );
}

#[tokio::test]
async fn bound_listener_path_is_stale_socket_path() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    let _listener = match UnixListener::bind(&socket_path).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping test: failed to bind unix socket: {err}");
            return;
        }
        Err(err) => panic!("failed to bind test socket: {err}"),
    };

    assert!(
        is_stale_socket_path(&socket_path)
            .await
            .expect("stale socket check should succeed")
    );
}

#[tokio::test]
async fn stream_round_trips_data_between_listener_and_client() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    let mut listener = match UnixListener::bind(&socket_path).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping test: failed to bind unix socket: {err}");
            return;
        }
        Err(err) => panic!("failed to bind test socket: {err}"),
    };

    let server_task = tokio::spawn(async move {
        let mut server_stream = listener.accept().await.expect("connection should accept");
        let mut request = [0; 7];
        server_stream
            .read_exact(&mut request)
            .await
            .expect("server should read request");
        assert_eq!(&request, b"request");
        server_stream
            .write_all(b"response")
            .await
            .expect("server should write response");
    });

    let mut client_stream = UnixStream::connect(&socket_path)
        .await
        .expect("client should connect");
    client_stream
        .write_all(b"request")
        .await
        .expect("client should write request");
    let mut response = [0; 8];
    client_stream
        .read_exact(&mut response)
        .await
        .expect("client should read response");
    assert_eq!(&response, b"response");

    server_task.await.expect("server task should join");
}

const TEST_SOCKET_DESCRIPTION: &str = "test socket";

#[tokio::test]
async fn reclaim_stale_socket_path_accepts_missing_path() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("nested").join("socket");

    reclaim_stale_socket_path(&socket_path, TEST_SOCKET_DESCRIPTION)
        .await
        .expect("missing path should be reclaimable");

    // The parent is created as a side effect so the caller can bind immediately.
    assert!(socket_path.parent().expect("parent").is_dir());
    assert!(!socket_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_stale_socket_path_removes_socket_left_by_a_dead_owner() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    let listener = match UnixListener::bind(&socket_path).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping test: failed to bind unix socket: {err}");
            return;
        }
        Err(err) => panic!("failed to bind test socket: {err}"),
    };
    // Dropping the listener closes the socket without unlinking the path, which
    // is exactly the state a SIGKILLed owner leaves behind.
    drop(listener);
    assert!(socket_path.exists());

    reclaim_stale_socket_path(&socket_path, TEST_SOCKET_DESCRIPTION)
        .await
        .expect("stale socket should be reclaimed");

    assert!(!socket_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_stale_socket_path_refuses_to_steal_a_live_socket() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    let _listener = match UnixListener::bind(&socket_path).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping test: failed to bind unix socket: {err}");
            return;
        }
        Err(err) => panic!("failed to bind test socket: {err}"),
    };

    let err = reclaim_stale_socket_path(&socket_path, TEST_SOCKET_DESCRIPTION)
        .await
        .expect_err("a live socket must not be reclaimed");

    assert_eq!(err.kind(), ErrorKind::AddrInUse);
    assert!(err.to_string().contains(TEST_SOCKET_DESCRIPTION));
    assert!(socket_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn reclaim_stale_socket_path_refuses_a_non_socket_path() {
    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    std::fs::write(&socket_path, b"not a socket").expect("regular file should be created");

    let err = reclaim_stale_socket_path(&socket_path, TEST_SOCKET_DESCRIPTION)
        .await
        .expect_err("a regular file must not be unlinked");

    assert_eq!(err.kind(), ErrorKind::AlreadyExists);
    assert!(socket_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn restrict_socket_permissions_makes_a_bound_socket_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let temp_dir = tempfile::TempDir::new().expect("temp dir");
    let socket_path = temp_dir.path().join("socket");
    let _listener = match UnixListener::bind(&socket_path).await {
        Ok(listener) => listener,
        Err(err) if err.kind() == ErrorKind::PermissionDenied => {
            eprintln!("skipping test: failed to bind unix socket: {err}");
            return;
        }
        Err(err) => panic!("failed to bind test socket: {err}"),
    };

    restrict_socket_permissions(&socket_path)
        .await
        .expect("socket permissions should be restricted");

    let mode = std::fs::metadata(&socket_path)
        .expect("socket metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}
