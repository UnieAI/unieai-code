// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use pretty_assertions::assert_eq;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;

fn provider(id: &str, base_url: &str, models: &[&str]) -> SelfHostedProvider {
    SelfHostedProvider {
        id: id.to_string(),
        name: None,
        base_url: base_url.to_string(),
        api_key: None,
        api_key_env: None,
        models: models
            .iter()
            .map(|id| SelfHostedModel {
                id: id.to_string(),
                context_window: None,
                vision: false,
            })
            .collect(),
        manual_models: false,
    }
}

#[test]
fn base_urls_are_normalized() {
    let cases = [
        ("localhost:11434", "http://localhost:11434/v1"),
        ("http://gpu-box:8000/", "http://gpu-box:8000/v1"),
        ("https://llm.example.com/v1/", "https://llm.example.com/v1"),
        (
            "http://10.0.0.5:8000/v1/chat/completions",
            "http://10.0.0.5:8000/v1",
        ),
        ("http://h:1/v1/models", "http://h:1/v1"),
        ("http://h:1/openai/v1", "http://h:1/openai/v1"),
    ];
    for (raw, expected) in cases {
        assert_eq!(normalize_base_url(raw).expect(raw), expected, "{raw}");
    }
    assert!(normalize_base_url("  ").is_err());
    assert!(normalize_base_url("ftp://h/v1").is_err());
}

#[test]
fn provider_ids_are_checked() {
    assert!(validate_provider_id("gpu-box").is_ok());
    assert!(validate_provider_id("vllm_2").is_ok());
    assert!(validate_provider_id("").is_err());
    assert!(validate_provider_id("Has Space").is_err());
    assert!(validate_provider_id("-leading").is_err());
    assert!(validate_provider_id("unieai").is_err());
    assert!(validate_provider_id("ollama").is_err());
}

#[test]
fn default_ids_come_from_the_host_and_stay_unique() {
    assert_eq!(
        default_provider_id("http://localhost:8000/v1", &[]),
        "local"
    );
    assert_eq!(
        default_provider_id("http://127.0.0.1:8000/v1", &[]),
        "local"
    );
    assert_eq!(
        default_provider_id("http://gpu-box.lan:8000/v1", &[]),
        "gpu-box"
    );
    assert_eq!(
        default_provider_id("http://10.1.2.3:8000/v1", &[]),
        "server-10-1-2-3"
    );
    let existing = [provider("local", "http://localhost:11434/v1", &["a"])];
    // The same server again replaces it; another one gets a new id.
    assert_eq!(
        default_provider_id("http://localhost:11434/v1", &existing),
        "local"
    );
    assert_eq!(
        default_provider_id("http://localhost:8000/v1", &existing),
        "local-2"
    );
}

#[test]
fn store_round_trips_owner_only_and_never_debug_prints_the_key() {
    let home = tempfile::tempdir().expect("tempdir");
    assert_eq!(load_self_hosted_providers(home.path()), Vec::new());

    let mut vllm = provider("vllm", "http://gpu:8000/v1", &["Qwen/Qwen3-8B"]);
    vllm.api_key = Some("sk-secret".to_string());
    vllm.models[0].context_window = Some(40_960);
    vllm.models[0].vision = true;
    upsert_self_hosted_provider(home.path(), vllm.clone()).expect("save");
    upsert_self_hosted_provider(
        home.path(),
        provider("local", "http://localhost:11434/v1", &["qwen2.5:0.5b"]),
    )
    .expect("save");

    let loaded = load_self_hosted_providers(home.path());
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0], vllm);
    assert!(!format!("{:?}", loaded[0]).contains("sk-secret"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(self_hosted_path(home.path()))
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // Replacing keeps the order; removing the last one removes the file.
    let mut replaced = vllm.clone();
    replaced.models.clear();
    upsert_self_hosted_provider(home.path(), replaced.clone()).expect("save");
    assert_eq!(load_self_hosted_providers(home.path())[0], replaced);
    assert!(remove_self_hosted_provider(home.path(), "vllm").expect("remove"));
    assert!(!remove_self_hosted_provider(home.path(), "vllm").expect("remove"));
    assert!(remove_self_hosted_provider(home.path(), "local").expect("remove"));
    assert!(!self_hosted_path(home.path()).exists());
}

#[test]
fn a_malformed_store_is_an_error_but_loads_as_empty() {
    let home = tempfile::tempdir().expect("tempdir");
    std::fs::write(self_hosted_path(home.path()), "{not json").expect("write");
    assert!(read_self_hosted_providers(home.path()).is_err());
    assert_eq!(load_self_hosted_providers(home.path()), Vec::new());
}

#[test]
fn slugs_name_a_server_and_its_model() {
    let providers = [
        provider("vllm", "http://gpu:8000/v1", &["Qwen/Qwen3-8B"]),
        provider("local", "http://localhost:11434/v1", &["qwen2.5:0.5b"]),
    ];
    assert_eq!(providers[0].slug("Qwen/Qwen3-8B"), "vllm/Qwen/Qwen3-8B");
    let (server, model) = find_self_hosted_model(&providers, "vllm/Qwen/Qwen3-8B").expect("found");
    assert_eq!(
        (server.id.as_str(), model.id.as_str()),
        ("vllm", "Qwen/Qwen3-8B")
    );
    assert!(find_self_hosted_model(&providers, "local/qwen2.5:0.5b").is_some());
    assert!(find_self_hosted_model(&providers, "local/missing").is_none());
    assert!(find_self_hosted_model(&providers, "DeepSeek-V4-Flash").is_none());
}

#[test]
fn model_provider_info_uses_the_stored_key_or_the_env_var() {
    let mut stored = provider("vllm", "http://gpu:8000/v1", &["m"]);
    stored.api_key = Some("sk-secret".to_string());
    let info = stored.model_provider_info();
    assert_eq!(info.base_url.as_deref(), Some("http://gpu:8000/v1"));
    assert!(info.experimental_bearer_token.is_some());
    assert_eq!(info.env_key, None);
    assert_eq!(info.wire_api, WireApi::Responses);

    let mut from_env = provider("vllm", "http://gpu:8000/v1", &["m"]);
    from_env.api_key_env = Some("VLLM_KEY".to_string());
    let info = from_env.model_provider_info();
    assert_eq!(info.env_key.as_deref(), Some("VLLM_KEY"));
    assert!(info.experimental_bearer_token.is_none());
    assert_eq!(from_env.key_source(), "API key from $VLLM_KEY");
    assert_eq!(stored.key_source(), "stored API key");
}

#[test]
fn models_responses_from_common_servers_are_understood() {
    // vLLM reports its window as max_model_len.
    let vllm = serde_json::json!({"object": "list", "data": [
        {"id": "Qwen/Qwen3-8B", "object": "model", "max_model_len": 40960}
    ]});
    assert_eq!(
        parse_models_response(&vllm),
        Some(vec![DiscoveredModel {
            id: "Qwen/Qwen3-8B".to_string(),
            context_window: Some(40960),
        }])
    );
    // llama.cpp server keeps it in meta.
    let llama_cpp = serde_json::json!({"data": [
        {"id": "model.gguf", "meta": {"n_ctx_train": 8192}}
    ]});
    assert_eq!(
        parse_models_response(&llama_cpp).expect("models")[0].context_window,
        Some(8192)
    );
    // Ollama's /v1/models has ids only.
    let ollama = serde_json::json!({"object": "list", "data": [
        {"id": "qwen2.5:0.5b", "object": "model", "owned_by": "library"}
    ]});
    assert_eq!(
        parse_models_response(&ollama).expect("models")[0].context_window,
        None
    );
    assert_eq!(parse_models_response(&serde_json::json!({"oops": 1})), None);
}

async fn models_server(status: u16, body: serde_json::Value) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn adding_a_server_discovers_its_models_and_saves_the_key() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .and(header("authorization", "Bearer sk-test"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [{"id": "llama3", "max_model_len": 8192}, {"id": "llava"}]
        })))
        .mount(&server)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    let added = add_self_hosted_provider(
        home.path(),
        SelfHostedRequest {
            base_url: server.uri(),
            name: Some("box".to_string()),
            api_key: Some("sk-test".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("added");
    assert_eq!(added.base_url, format!("{}/v1", server.uri()));
    let ids: Vec<_> = added.models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["llama3", "llava"]);
    assert_eq!(added.models[0].context_window, Some(8192));
    assert_eq!(load_self_hosted_providers(home.path()), vec![added]);
}

#[tokio::test]
async fn manual_models_and_overrides_replace_discovery() {
    let server = models_server(200, serde_json::json!({"data": [{"id": "a"}, {"id": "b"}]})).await;
    let home = tempfile::tempdir().expect("tempdir");
    let added = add_self_hosted_provider(
        home.path(),
        SelfHostedRequest {
            base_url: format!("{}/v1", server.uri()),
            models: vec!["b".to_string()],
            context_window: Some(65_536),
            vision: true,
            ..Default::default()
        },
    )
    .await
    .expect("added");
    assert!(added.manual_models);
    assert_eq!(
        added.models,
        vec![SelfHostedModel {
            id: "b".to_string(),
            context_window: Some(65_536),
            vision: true,
        }]
    );
}

#[tokio::test]
async fn probe_failures_are_told_apart() {
    let home = tempfile::tempdir().expect("tempdir");
    let add = |base_url: String| {
        let home = home.path().to_path_buf();
        async move {
            add_self_hosted_provider(
                &home,
                SelfHostedRequest {
                    base_url,
                    ..Default::default()
                },
            )
            .await
        }
    };

    let unauthorized = models_server(401, serde_json::json!({"error": "no key"})).await;
    let err = add(unauthorized.uri()).await.expect_err("401");
    assert!(
        matches!(err, SelfHostedError::Unauthorized { status: 401, .. }),
        "{err}"
    );
    assert!(err.to_string().contains("API key"), "{err}");

    let empty = models_server(200, serde_json::json!({"data": []})).await;
    let err = add(empty.uri()).await.expect_err("no models");
    assert!(matches!(err, SelfHostedError::NoModels { .. }), "{err}");

    let not_openai = models_server(404, serde_json::json!({})).await;
    let err = add(not_openai.uri()).await.expect_err("404");
    assert!(matches!(err, SelfHostedError::BadResponse { .. }), "{err}");

    // Nothing listens on a port just released.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("port")
        .port();
    let err = add(format!("http://127.0.0.1:{port}"))
        .await
        .expect_err("down");
    assert!(matches!(err, SelfHostedError::Unreachable { .. }), "{err}");
    assert!(err.to_string().contains("could not reach"), "{err}");

    // Nothing was saved along the way.
    assert_eq!(load_self_hosted_providers(home.path()), Vec::new());
}
