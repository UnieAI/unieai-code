use std::io::ErrorKind;

use pretty_assertions::assert_eq;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;

use super::*;

#[cfg(windows)]
#[tokio::test]
async fn private_directory_rejects_volume_roots() {
    // A nonexistent volume keeps this regression safe even if root validation breaks.
    let root = Path::new(r"\\?\Volume{00000000-0000-0000-0000-000000000000}\");
    assert_eq!(
        prepare_private_socket_directory(root)
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::InvalidInput,
    );
}

#[cfg(windows)]
#[tokio::test]
async fn private_directory_rejects_junctions() {
    let temp = tempfile::TempDir::new().expect("temp directory");
    let target = temp.path().join("target");
    let junction = temp.path().join("junction");
    std::fs::create_dir(&target).expect("target");
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:CODEX_TEST_LINK -Target $env:CODEX_TEST_TARGET | Out-Null"])
        .env("CODEX_TEST_LINK", &junction)
        .env("CODEX_TEST_TARGET", &target)
        .output().expect("create junction");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        prepare_private_socket_directory(&junction)
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::PermissionDenied,
    );
    assert_eq!(
        validate_private_socket_path(&junction.join("socket"))
            .unwrap_err()
            .kind(),
        ErrorKind::PermissionDenied,
    );
}

#[cfg(windows)]
#[tokio::test]
async fn socket_validation_pins_private_directory_without_creating_missing_paths() {
    let temp = tempfile::TempDir::new().expect("temp directory");
    let directory = temp.path().join("private");
    let socket_path = directory.join("socket");
    assert!(validate_private_socket_path(&socket_path).is_err());
    assert!(!directory.exists());
    prepare_private_socket_directory(&directory).await.unwrap();
    let (_validated_path, _guard) = validate_private_socket_path(&socket_path).unwrap();
    assert!(std::fs::rename(&directory, temp.path().join("moved")).is_err());
}

#[cfg(windows)]
#[tokio::test]
async fn socket_validation_rejects_broad_acl_without_repairing_it() {
    let temp = tempfile::TempDir::new().expect("temp directory");
    let directory = temp.path().join("private");
    prepare_private_socket_directory(&directory).await.unwrap();
    let inspect = |script: &str| {
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("CODEX_TEST_DIRECTORY", &directory)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    let before = inspect(
        r#"
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:CODEX_TEST_DIRECTORY
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:CODEX_TEST_DIRECTORY -AclObject $acl
(Get-Acl -LiteralPath $env:CODEX_TEST_DIRECTORY).Sddl
"#,
    );
    assert_eq!(
        validate_private_socket_path(&directory.join("socket"))
            .unwrap_err()
            .kind(),
        ErrorKind::PermissionDenied,
    );
    assert_eq!(
        prepare_private_socket_directory(&directory)
            .await
            .unwrap_err()
            .kind(),
        ErrorKind::PermissionDenied,
    );
    assert_eq!(
        before,
        inspect(
            "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:CODEX_TEST_DIRECTORY).Sddl"
        )
    );
}

#[cfg(windows)]
#[tokio::test]
async fn private_directory_supports_extended_length_paths() {
    let temp = tempfile::TempDir::new().expect("temp directory");
    let directory = temp.path().join("a".repeat(150)).join("b".repeat(150));
    prepare_private_socket_directory(&directory)
        .await
        .expect("create long private directory");
    prepare_private_socket_directory(&directory)
        .await
        .expect("validate long private directory");
    assert!(directory.is_dir());
}

#[cfg(windows)]
#[tokio::test]
async fn private_directory_acl_is_user_only_and_inherited_by_files() {
    let temp = tempfile::TempDir::new().expect("temp directory");
    let directory = temp.path().join("private");
    // Cover reusing an existing private directory as well as inheriting its DACL.
    prepare_private_socket_directory(&directory)
        .await
        .expect("create user-owned directory");
    prepare_private_socket_directory(&directory)
        .await
        .expect("private directory");
    std::fs::write(directory.join("child"), b"").expect("child file");
    let _listener = UnixListener::bind(directory.join("socket"))
        .await
        .expect("private socket");
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", r#"
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directory = Get-Acl -LiteralPath $env:CODEX_TEST_PRIVATE_DIRECTORY
if (-not $directory.AreAccessRulesProtected) { throw 'directory inherits broad access' }
foreach ($acl in @($directory, (Get-Acl -LiteralPath (Join-Path $env:CODEX_TEST_PRIVATE_DIRECTORY 'child')), (Get-Acl -LiteralPath (Join-Path $env:CODEX_TEST_PRIVATE_DIRECTORY 'socket')))) {
    $rules = @($acl.Access)
    if ($rules.Count -ne 1) { throw 'unexpected access rules' }
    if ($rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { throw 'wrong user' }
    if ($rules[0].AccessControlType -ne 'Allow') { throw 'user is denied access' }
}
"#])
        .env("CODEX_TEST_PRIVATE_DIRECTORY", &directory)
        .output().expect("inspect ACLs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

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
#[cfg(windows)]
#[tokio::test]
async fn implicit_peer_validation_rejects_elevated_listener() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("socket");
    let mut listener = UnixListener::bind(&path).await.unwrap();
    let client = UnixStream::connect(&path).await.unwrap();
    let _server = listener.accept().await.unwrap();
    // PowerShell inherits our token and supplies an independent elevation oracle.
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"])
        .output().unwrap();
    assert!(output.status.success());
    let expected = match String::from_utf8(output.stdout).unwrap().trim() {
        "True" => Err(ErrorKind::PermissionDenied),
        "False" => Ok(()),
        other => panic!("unexpected elevation result: {other}"),
    };
    assert_eq!(
        client.ensure_non_elevated_peer().map_err(|err| err.kind()),
        expected
    );
}
