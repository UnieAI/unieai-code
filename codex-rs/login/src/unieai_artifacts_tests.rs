// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::unieai::UnieAICredentials;
use crate::unieai::save_unieai_credentials;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::body_json;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::matchers::query_param;

const KEY: &str = "rk-secret-desktop-key";

fn credentials(account: UnieAIAccountKind, url: &str) -> UnieAICredentials {
    UnieAICredentials {
        account,
        studio_url: url.to_string(),
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: i64::MAX,
        email: Some("u@example.com".to_string()),
        active_org_id: None,
        gateway_base_url: format!("{url}/api/desktop/v1"),
        gateway_api_key: KEY.to_string(),
        gateway_base_url_locked: true,
        available_model_ids: None,
        available_models: None,
    }
}

fn page(body: &str) -> String {
    format!(
        "<!doctype html><html><head><title> Weekly   Report </title></head><body>{body}</body></html>"
    )
}

#[test]
fn only_a_rabi_login_can_publish() {
    let home = tempfile::tempdir().expect("tempdir");
    let err = artifacts_account(home.path()).expect_err("no login");
    assert_eq!(err.code, "not_signed_in");

    save_unieai_credentials(
        home.path(),
        &credentials(UnieAIAccountKind::Studio, "https://studio.example.com"),
    )
    .expect("save");
    let err = artifacts_account(home.path()).expect_err("studio");
    assert_eq!(err.code, "not_rabi");
    assert!(
        err.message.contains("unieai login --rabi"),
        "{}",
        err.message
    );

    save_unieai_credentials(
        home.path(),
        &credentials(UnieAIAccountKind::Rabi, "https://agent.example.com/"),
    )
    .expect("save");
    let account = artifacts_account(home.path()).expect("rabi");
    assert_eq!(account.base_url, "https://agent.example.com");
    assert_eq!(account.account, "https://agent.example.com|u@example.com");
    assert!(!format!("{account:?}").contains(KEY), "Debug hides the key");
}

#[test]
fn sites_are_collected_and_checked_against_avas_limits() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("index.html"), page("x")).expect("write");
    std::fs::create_dir(dir.path().join("assets")).expect("mkdir");
    std::fs::write(dir.path().join("assets").join("a.svg"), "<svg/>").expect("write");
    std::fs::write(dir.path().join(".hidden"), "x").expect("write");
    let files = collect_site(dir.path()).expect("collect");
    assert_eq!(
        files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        vec!["assets/a.svg", "index.html"]
    );
    assert_eq!(title_of(&files).as_deref(), Some("Weekly Report"));
    validate_site(&files).expect("valid");

    std::fs::write(dir.path().join("r.html"), page("r")).expect("write");
    let single = collect_site(&dir.path().join("r.html")).expect("single");
    assert_eq!(single[0].path, "index.html");
    assert_eq!(
        collect_site(&dir.path().join("assets"))
            .expect_err("no entry")
            .code,
        "no_entry"
    );
    assert_eq!(
        collect_site(&dir.path().join("assets").join("a.svg"))
            .expect_err("not html")
            .code,
        "not_html"
    );

    let big = vec![SiteFile {
        path: "index.html".to_string(),
        bytes: vec![b' '; (MAX_FILE_BYTES + 1) as usize],
    }];
    let err = validate_site(&big).expect_err("too big");
    assert_eq!(err.code, "too_large");
    assert!(err.message.contains("4.0 MiB per file"), "{}", err.message);
    let mut many = vec![SiteFile {
        path: "index.html".to_string(),
        bytes: page("x").into_bytes(),
    }];
    many.extend((0..49).map(|i| SiteFile {
        path: format!("{i}.txt"),
        bytes: b"x".to_vec(),
    }));
    assert!(
        validate_site(&many)
            .expect_err("too many")
            .message
            .contains("49 files besides index.html; the limit is 48")
    );
}

#[test]
fn upload_body_has_avas_shape() {
    let files = vec![SiteFile {
        path: "index.html".to_string(),
        bytes: b"<p>hi</p>".to_vec(),
    }];
    let body = SiteUpload::new("T".to_string(), None, &files);
    assert_eq!(
        serde_json::to_value(&body).expect("json"),
        serde_json::json!({
            "title": "T",
            "entry": "index.html",
            "files": [{"path": "index.html", "mime": "text/html", "contentBase64": "PHA+aGk8L3A+"}]
        }),
        "an update without visibility or header keeps the page's"
    );
}

#[test]
fn id_memory_is_per_workspace_and_account() {
    let home = tempfile::tempdir().expect("tempdir");
    let memory = IdMemory::new(home.path());
    let ws = Path::new("/w/repo");
    let file = ws.join("pages").join("a.html");
    let entry = |id: &str, account: &str| MemoryEntry {
        id: id.to_string(),
        account: account.to_string(),
        viewer_url: String::new(),
        version: Some(1),
        title: "A".to_string(),
        updated_at: None,
    };
    memory
        .remember(ws, &file, entry("art_1", "acct"))
        .expect("remember");
    assert_eq!(
        memory.lookup(ws, &file, "acct").map(|e| e.id),
        Some("art_1".to_string())
    );
    assert_eq!(memory.lookup(ws, &file, "other"), None);
    assert_eq!(memory.lookup(Path::new("/w/other"), &file, "acct"), None);
    let text = std::fs::read_to_string(home.path().join("artifacts.json")).expect("read");
    let json: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(json["workspaces"]["/w/repo"]["pages/a.html"]["id"], "art_1");
    assert_eq!(memory.paths_of("art_1"), vec![file.clone()]);
    assert!(memory.forget("art_1").expect("forget"));
    assert_eq!(memory.lookup(ws, &file, "acct"), None);
}

#[tokio::test]
async fn routes_carry_the_bearer_key_and_map_errors() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/agent-next/artifacts/site"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .and(body_partial_json(
            serde_json::json!({"entry": "index.html", "visibility": "private"}),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 1}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(body_partial_json(serde_json::json!({"expectedVersion": 1})))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "error": {"code": "version_conflict", "message": "stale", "currentVersion": 3}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(body_partial_json(serde_json::json!({"expectedVersion": 3})))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 4}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/agent-next/artifacts"))
        .and(query_param("mine", "1"))
        .and(query_param("source", "unieai-code"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "mine": [{"id": "art_1", "title": "Weekly Report", "url": "/share/html/tok", "viewerUrl": "/share/html/tok", "version": 4, "updatedAt": "2026-10-20T00:00:00Z", "source": "unieai-code"}],
            "org": [],
            "usage": {"activeShares": 1},
            "limits": {"activeShares": 100}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(body_json(
            serde_json::json!({"visibility": "org", "header": null}),
        ))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "error": {"code": "org_required", "message": "several orgs"}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(body_json(serde_json::json!({"visibility": "org", "orgId": "o2", "header": {"icon": "chart", "showAuthor": true}})))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 4}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(query_param("expectedVersion", "4"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/agent-next/artifacts/art_9"))
        .respond_with(ResponseTemplate::new(429).set_body_json(serde_json::json!({
            "error": {"code": "quota_exceeded", "message": format!("full for {KEY}")}
        })))
        .mount(&server)
        .await;

    let account = ArtifactsAccount::new(&server.uri(), KEY, "acct");
    let client = ArtifactsClient::new(account);
    let home = tempfile::tempdir().expect("tempdir");
    let memory = IdMemory::new(home.path());
    let ws = tempfile::tempdir().expect("ws");
    let file = ws.path().join("report.html");
    std::fs::write(&file, page("v1")).expect("write");

    let request = || PublishRequest {
        path: file.clone(),
        ..Default::default()
    };
    let created = publish(&client, &memory, ws.path(), request())
        .await
        .expect("create");
    assert_eq!(
        created,
        PublishOutcome {
            id: "art_1".to_string(),
            viewer_url: format!("{}/share/html/tok", server.uri()),
            version: 1,
            title: "Weekly Report".to_string(),
            created: true,
        }
    );

    // The same path again is an update in place; the page moved on to v3.
    let err = publish(&client, &memory, ws.path(), request())
        .await
        .expect_err("conflict");
    assert_eq!(err.code, "version_conflict");
    assert_eq!(err.current_version, Some(3));
    let forced = publish(
        &client,
        &memory,
        ws.path(),
        PublishRequest {
            force: true,
            ..request()
        },
    )
    .await
    .expect("forced");
    assert_eq!((forced.created, forced.version), (false, 4));
    assert_eq!(
        memory
            .lookup(ws.path(), &file, "acct")
            .and_then(|e| e.version),
        Some(4)
    );

    let listed = client.list().await.expect("list");
    assert_eq!(listed.mine[0].title, "Weekly Report");
    assert_eq!(listed.mine[0].version, Some(4));
    assert_eq!(listed.mine[0].link(), "/share/html/tok");
    assert_eq!(
        listed.limits,
        Some(serde_json::json!({"activeShares": 100}))
    );

    let err = client
        .update_settings(
            "art_1",
            &SettingsPatch {
                visibility: Some("org".to_string()),
                org_id: None,
                header: Some(None),
            },
        )
        .await
        .expect_err("org required");
    assert_eq!(err.code, "org_required");
    assert!(err.message.contains("--org-id"), "{}", err.message);
    let patched = client
        .update_settings(
            "art_1",
            &SettingsPatch {
                visibility: Some("org".to_string()),
                org_id: Some("o2".to_string()),
                header: Some(Some(ArtifactHeader {
                    icon: Some("chart".to_string()),
                    show_author: Some(true),
                    ..Default::default()
                })),
            },
        )
        .await
        .expect("patch");
    assert_eq!(patched.version, 4);

    client.delete("art_1", Some(4)).await.expect("delete");
    let err = client.delete("art_9", None).await.expect_err("quota");
    assert_eq!(err.code, "quota_exceeded");
    assert!(!err.message.contains(KEY), "{}", err.message);

    let refused = ArtifactsClient::new(ArtifactsAccount::new(&server.uri(), "wrong", "acct"));
    let err = refused
        .create(&SiteUpload::new("T".to_string(), None, &[]))
        .await
        .expect_err("unmatched mock is a 404");
    assert_eq!(err.code, "not_found");
}

#[tokio::test]
async fn ava_errors_carry_path_reference_issues_and_hints() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/agent-next/artifacts/site"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "error": {"code": "external_ref", "message": "external reference", "path": "index.html",
                      "reference": "https://x.example/a.js", "issues": ["index.html: https://x.example/a.js"]}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/agent-next/artifacts/chat_1"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "error": {"code": "not_uploadable", "message": "published from a chat"}
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/agent-next/artifacts"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "error": {"code": "forbidden", "message": "missing scope"}
        })))
        .mount(&server)
        .await;
    let client = ArtifactsClient::new(ArtifactsAccount::new(&server.uri(), KEY, "acct"));
    let files = vec![SiteFile {
        path: "index.html".to_string(),
        bytes: b"x".to_vec(),
    }];
    let body = SiteUpload::new("T".to_string(), None, &files);
    let err = client.create(&body).await.expect_err("external ref");
    assert_eq!(err.code, "external_ref");
    assert_eq!(
        err.message,
        "ava refused it (external_ref): external reference (index.html https://x.example/a.js) Inline it, or use cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com or Google Fonts.\n- index.html: https://x.example/a.js"
    );
    let err = client
        .update("chat_1", &body, 1)
        .await
        .expect_err("chat page");
    assert_eq!(err.code, "not_uploadable");
    assert!(
        err.message.contains("published from an ava chat"),
        "{}",
        err.message
    );
    let err = client.list().await.expect_err("scope");
    assert_eq!(err.code, "unauthorized");
    assert!(err.message.contains("`artifacts` scope"), "{}", err.message);

    let big = vec![SiteFile {
        path: "index.html".to_string(),
        bytes: vec![b'x'; (MAX_BODY_BYTES as usize / 4) * 3 + 1024],
    }];
    let err = client
        .create(&SiteUpload::new("T".to_string(), None, &big))
        .await
        .expect_err("body too large, checked locally");
    assert_eq!(err.code, "too_large");
    assert!(
        err.message.contains("23.0 MiB per request"),
        "{}",
        err.message
    );
}
