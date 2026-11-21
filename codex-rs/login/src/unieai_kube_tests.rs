// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::unieai::save_unieai_credentials;
use pretty_assertions::assert_eq;
use serde_json::json;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

fn studio_home(server: &MockServer) -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("tempdir");
    save_unieai_credentials(
        home.path(),
        &UnieAICredentials {
            account: UnieAIAccountKind::Studio,
            studio_url: server.uri(),
            access_token: "device-access".to_string(),
            refresh_token: "device-refresh".to_string(),
            expires_at: Utc::now().timestamp() + 3600,
            email: None,
            active_org_id: None,
            gateway_base_url: format!("{}/v1", server.uri()),
            gateway_api_key: "gw".to_string(),
            gateway_base_url_locked: false,
            available_model_ids: None,
            available_models: None,
        },
    )
    .expect("save");
    home
}

fn credential_body(token: &str, expires: DateTime<Utc>) -> Value {
    json!({
        "apiVersion": "client.authentication.k8s.io/v1",
        "kind": "ExecCredential",
        "status": {"token": token, "expirationTimestamp": expires.to_rfc3339()}
    })
}

const TOKEN_PATH: &str = "/api/on-prem/clusters/cluster_vc1/access/token";

#[tokio::test]
async fn issues_a_token_with_the_device_login_and_caches_it() {
    let server = MockServer::start().await;
    let expires = Utc::now() + chrono::Duration::minutes(15);
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .and(header("authorization", "Bearer device-access"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(credential_body("sa-token", expires)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let home = studio_home(&server);

    let first = kube_token(home.path(), "cluster_vc1", Some(&server.uri()))
        .await
        .expect("token");
    assert_eq!(first.status.token, "sa-token");
    assert_eq!(first.kind, "ExecCredential");
    // The second call is answered from the cache (the mock allows one request).
    let second = kube_token(home.path(), "cluster_vc1", None)
        .await
        .expect("cached");
    assert_eq!(second, first);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(cache_path(home.path(), "cluster_vc1"))
            .expect("cache file")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[tokio::test]
async fn a_token_close_to_expiry_is_fetched_again() {
    let server = MockServer::start().await;
    let soon = Utc::now() + chrono::Duration::seconds(30);
    let later = Utc::now() + chrono::Duration::minutes(15);
    let home = studio_home(&server);
    write_cache(
        home.path(),
        "cluster_vc1",
        &server.uri(),
        &serde_json::from_value(credential_body("old", soon)).expect("credential"),
    )
    .expect("cache");
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(credential_body("new", later)))
        .expect(1)
        .mount(&server)
        .await;
    let credential = kube_token(home.path(), "cluster_vc1", None)
        .await
        .expect("token");
    assert_eq!(credential.status.token, "new");
}

#[tokio::test]
async fn waits_while_access_is_still_being_applied() {
    let server = MockServer::start().await;
    let expires = Utc::now() + chrono::Duration::minutes(15);
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .respond_with(ResponseTemplate::new(409).set_body_json(
            json!({"error": "權限套用中，請稍候幾秒再試。", "code": "access_pending"}),
        ))
        .up_to_n_times(2)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .respond_with(ResponseTemplate::new(200).set_body_json(credential_body("ready", expires)))
        .mount(&server)
        .await;
    let home = studio_home(&server);
    let credential = kube_token_with(
        home.path(),
        "cluster_vc1",
        None,
        None,
        Utc::now(),
        Duration::ZERO,
    )
    .await
    .expect("token");
    assert_eq!(credential.status.token, "ready");
}

#[tokio::test]
async fn explains_refusals() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/on-prem/clusters/cluster_denied/access/token"))
        .respond_with(ResponseTemplate::new(403).set_body_json(
            json!({"error": "你在這台 vCluster 沒有存取權限，請聯絡專案中負責管理存取的人。", "code": "no_vcluster_access"}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/on-prem/clusters/cluster_gone/access/token"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"error": "找不到這台 vCluster。", "code": "not_found"})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/api/on-prem/clusters/cluster_private/access/kubeconfig",
        ))
        .respond_with(
            ResponseTemplate::new(409)
                .set_body_json(json!({"error": "relay off", "code": "relay_not_configured"})),
        )
        .mount(&server)
        .await;
    let home = studio_home(&server);
    assert_eq!(
        kube_token(home.path(), "cluster_denied", None).await,
        Err(KubeError::NoAccess(
            "你在這台 vCluster 沒有存取權限，請聯絡專案中負責管理存取的人。".to_string()
        ))
    );
    assert_eq!(
        kube_token(home.path(), "cluster_gone", None).await,
        Err(KubeError::NotFound("cluster_gone".to_string()))
    );
    assert_eq!(
        kube_kubeconfig(home.path(), "cluster_private").await,
        Err(KubeError::RelayDisabled)
    );
}

#[tokio::test]
async fn needs_a_studio_login_for_the_same_studio() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        kube_token(home.path(), "cluster_vc1", None).await,
        Err(KubeError::NotSignedIn)
    );
    let server = MockServer::start().await;
    let home = studio_home(&server);
    assert_eq!(
        kube_token(
            home.path(),
            "cluster_vc1",
            Some("https://studio.other.example")
        )
        .await,
        Err(KubeError::OtherStudio {
            wanted: "https://studio.other.example".to_string(),
            signed_in: server.uri(),
        })
    );
}

#[tokio::test]
async fn fetches_a_plugin_kubeconfig_and_clears_the_cache() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/on-prem/clusters/cluster_vc1/access/kubeconfig"))
        .and(header("authorization", "Bearer device-access"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "clusterId": "cluster_vc1",
            "kind": "exec",
            "fileName": "vcluster-cluster_vc1-exec.yaml",
            "kubeconfig": "apiVersion: v1\nkind: Config\n"
        })))
        .mount(&server)
        .await;
    let home = studio_home(&server);
    let (kubeconfig, name) = kube_kubeconfig(home.path(), "cluster_vc1")
        .await
        .expect("kubeconfig");
    assert_eq!(name, "vcluster-cluster_vc1-exec.yaml");
    assert!(kubeconfig.starts_with("apiVersion: v1"));

    let expires = Utc::now() + chrono::Duration::minutes(15);
    write_cache(
        home.path(),
        "cluster_vc1",
        &server.uri(),
        &serde_json::from_value(credential_body("t", expires)).expect("credential"),
    )
    .expect("cache");
    assert_eq!(clear_kube_token_cache(home.path()).expect("clear"), 1);
    assert_eq!(clear_kube_token_cache(home.path()).expect("clear again"), 0);
}

#[test]
fn cache_files_never_escape_the_cache_directory() {
    let home = Path::new("/home/u/.unieai");
    assert_eq!(
        cache_path(home, "../../etc/passwd"),
        home.join("unieai-kube").join(".._.._etc_passwd.json")
    );
    assert_eq!(
        cluster_path("a/b c", "token"),
        "/api/on-prem/clusters/a%2Fb%20c/access/token"
    );
}

#[tokio::test]
async fn a_machine_identity_key_needs_no_sign_in() {
    let server = MockServer::start().await;
    let expires = Utc::now() + chrono::Duration::minutes(15);
    Mock::given(method("POST"))
        .and(path(TOKEN_PATH))
        .and(header("authorization", "Bearer mk_live_1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(credential_body("ci-token", expires)),
        )
        .expect(1)
        .mount(&server)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(
        kube_token_with(
            home.path(),
            "cluster_vc1",
            None,
            Some("mk_live_1"),
            Utc::now(),
            Duration::ZERO
        )
        .await,
        Err(KubeError::MachineKeyNeedsStudio)
    );
    let credential = kube_token_with(
        home.path(),
        "cluster_vc1",
        Some(&server.uri()),
        Some("mk_live_1"),
        Utc::now(),
        Duration::ZERO,
    )
    .await
    .expect("token");
    assert_eq!(credential.status.token, "ci-token");
    assert!(cache_path(home.path(), "machine-cluster_vc1").exists());
}
