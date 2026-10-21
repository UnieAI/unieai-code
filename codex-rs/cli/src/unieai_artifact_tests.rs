// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use clap::Parser;
use pretty_assertions::assert_eq;
use std::sync::Mutex;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

const KEY: &str = "rk-cli-test-key";

fn parse(args: &[&str]) -> ArtifactSubcommand {
    let mut argv = vec!["artifact"];
    argv.extend_from_slice(args);
    ArtifactCommand::try_parse_from(argv)
        .expect("parse")
        .subcommand
}

#[test]
fn parses_list_open_delete_and_publish() {
    assert_eq!(parse(&["list"]), ArtifactSubcommand::List);
    assert_eq!(parse(&["ls"]), ArtifactSubcommand::List);
    assert_eq!(
        parse(&["open", "art_1"]),
        ArtifactSubcommand::Open {
            id: "art_1".to_string()
        }
    );
    assert_eq!(
        parse(&["rm", "art_2"]),
        ArtifactSubcommand::Delete {
            id: "art_2".to_string()
        }
    );
    assert_eq!(
        parse(&[
            "publish",
            "pages/report.html",
            "--title",
            "Q3 Report",
            "--id",
            "art_3"
        ]),
        ArtifactSubcommand::Publish {
            path: PathBuf::from("pages/report.html"),
            title: Some("Q3 Report".to_string()),
            description: None,
            id: Some("art_3".to_string()),
            visibility: None,
            org_id: None,
            force: false,
        }
    );
    assert_eq!(
        parse(&[
            "publish",
            "site",
            "--force",
            "--visibility",
            "org",
            "--org-id",
            "o1"
        ]),
        ArtifactSubcommand::Publish {
            path: PathBuf::from("site"),
            title: None,
            description: None,
            id: None,
            visibility: Some("org".to_string()),
            org_id: Some("o1".to_string()),
            force: true,
        }
    );
    assert_eq!(
        parse(&[
            "set",
            "art_1",
            "--visibility",
            "org",
            "--header-title",
            "Q3",
            "--header-icon",
            "chart",
            "--show-author",
            "true",
        ]),
        ArtifactSubcommand::Set {
            id: "art_1".to_string(),
            visibility: Some("org".to_string()),
            org_id: None,
            header_title: Some("Q3".to_string()),
            header_description: None,
            header_icon: Some("chart".to_string()),
            show_author: Some(true),
            clear_header: false,
        }
    );
    assert!(
        ArtifactCommand::try_parse_from(["artifact", "set", "a", "--visibility", "public"])
            .is_err()
    );
    assert!(
        ArtifactCommand::try_parse_from([
            "artifact",
            "set",
            "a",
            "--clear-header",
            "--header-icon",
            "x"
        ])
        .is_err()
    );
    assert!(ArtifactCommand::try_parse_from(["artifact", "open"]).is_err());
    assert!(ArtifactCommand::try_parse_from(["artifact", "publish"]).is_err());
}

#[test]
fn paths_resolve_lexically() {
    assert_eq!(
        resolve(Path::new("/w/repo/sub"), Path::new("../pages/./a.html")),
        PathBuf::from("/w/repo/pages/a.html")
    );
    assert_eq!(
        resolve(Path::new("/w"), Path::new("/abs/a.html")),
        PathBuf::from("/abs/a.html")
    );
}

fn rabi_home(url: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("home");
    std::fs::write(
        home.path().join("unieai.json"),
        serde_json::json!({
            "account": "rabi",
            "studio_url": url,
            "access_token": "",
            "refresh_token": "",
            "expires_at": i64::MAX,
            "gateway_base_url": format!("{url}/api/desktop/v1"),
            "gateway_api_key": KEY,
        })
        .to_string(),
    )
    .expect("write login");
    home
}

async fn run_to_string(
    args: &[&str],
    home: &Path,
    cwd: &Path,
    opened: &Mutex<Vec<String>>,
) -> anyhow::Result<String> {
    let mut argv = vec!["artifact"];
    argv.extend_from_slice(args);
    let mut out = Vec::new();
    let open = |url: &str| {
        opened.lock().expect("lock").push(url.to_string());
        Ok(())
    };
    run(
        ArtifactCommand::try_parse_from(argv)?,
        home,
        cwd,
        &mut out,
        &open,
    )
    .await?;
    Ok(String::from_utf8(out).expect("utf8"))
}

#[tokio::test]
async fn publish_list_open_delete_against_a_fake_ava() {
    let server = MockServer::start().await;
    let auth = format!("Bearer {KEY}");
    Mock::given(method("POST"))
        .and(path("/api/agent-next/artifacts/site"))
        .and(header("authorization", auth.as_str()))
        .respond_with(ResponseTemplate::new(201).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 1}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(wiremock::matchers::body_partial_json(
            serde_json::json!({"expectedVersion": 1, "title": "Renamed"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 2}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/agent-next/artifacts"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "mine": [{"id": "art_1", "title": "Renamed", "url": "/share/html/tok", "viewerUrl": "/share/html/tok", "version": 2, "source": "unieai-code"}],
            "org": [],
            "usage": {"activeShares": 1},
            "limits": {"activeShares": 100}
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 2, "files": []}),
        ))
        .mount(&server)
        .await;
    Mock::given(method("PATCH"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .and(wiremock::matchers::body_json(
            serde_json::json!({"visibility": "org", "header": {"icon": "chart"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"id": "art_1", "viewerUrl": "/share/html/tok", "version": 2}),
        ))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/api/agent-next/artifacts/art_1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let home = rabi_home(&server.uri());
    let ws = tempfile::tempdir().expect("ws");
    std::fs::create_dir(ws.path().join(".git")).expect("git");
    std::fs::write(
        ws.path().join("report.html"),
        "<html><head><title>Weekly Report</title></head><body>hi</body></html>",
    )
    .expect("page");
    let opened = Mutex::new(Vec::new());

    let out = run_to_string(&["publish", "report.html"], home.path(), ws.path(), &opened)
        .await
        .expect("publish");
    let url = format!("{}/share/html/tok", server.uri());
    assert_eq!(
        out,
        format!("Published \"Weekly Report\" (id art_1, version 1)\n{url}\n")
    );
    let out = run_to_string(
        &["publish", "report.html", "--title", "Renamed"],
        home.path(),
        ws.path(),
        &opened,
    )
    .await
    .expect("update");
    assert_eq!(
        out,
        format!("Updated \"Renamed\" (id art_1, version 2)\n{url}\n")
    );

    let out = run_to_string(&["list"], home.path(), ws.path(), &opened)
        .await
        .expect("list");
    assert_eq!(
        out,
        format!(
            "art_1  Renamed  v2\n    {url}\n    from {}\nUsage: activeShares 1/100\n",
            ws.path().join("report.html").display()
        )
    );
    let out = run_to_string(&["open", "art_1"], home.path(), ws.path(), &opened)
        .await
        .expect("open");
    assert_eq!(out, format!("{url}\n"));
    assert_eq!(*opened.lock().expect("lock"), vec![url.clone()]);
    let out = run_to_string(
        &[
            "set",
            "art_1",
            "--visibility",
            "org",
            "--header-icon",
            "chart",
        ],
        home.path(),
        ws.path(),
        &opened,
    )
    .await
    .expect("set");
    assert_eq!(out, format!("Updated the settings of art_1.\n{url}\n"));
    assert!(
        run_to_string(&["set", "art_1"], home.path(), ws.path(), &opened)
            .await
            .is_err()
    );
    let out = run_to_string(&["delete", "art_1"], home.path(), ws.path(), &opened)
        .await
        .expect("delete");
    assert_eq!(out, "Deleted art_1; its link no longer works.\n");
    let memory = std::fs::read_to_string(home.path().join("artifacts.json")).expect("memory");
    assert!(!memory.contains("art_1"), "{memory}");
    assert!(!memory.contains(KEY));
}

#[tokio::test]
async fn a_studio_login_is_told_to_link_rabi() {
    let home = tempfile::tempdir().expect("home");
    std::fs::write(
        home.path().join("unieai.json"),
        serde_json::json!({
            "studio_url": "https://studio.example.com",
            "access_token": "a",
            "refresh_token": "r",
            "expires_at": 0,
            "gateway_base_url": "https://gw/v1",
            "gateway_api_key": "k",
        })
        .to_string(),
    )
    .expect("write");
    let opened = Mutex::new(Vec::new());
    let err = run_to_string(&["list"], home.path(), home.path(), &opened)
        .await
        .expect_err("studio");
    assert!(err.to_string().contains("unieai login --rabi"), "{err}");
}
