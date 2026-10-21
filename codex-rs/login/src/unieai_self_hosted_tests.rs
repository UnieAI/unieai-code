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
        kind: None,
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
            vision: false,
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

#[test]
fn presets_have_valid_unique_default_names_and_their_documented_urls() {
    let kinds: Vec<_> = API_PRESETS.iter().map(|preset| preset.kind).collect();
    assert_eq!(
        kinds,
        [
            "openai",
            "openrouter",
            "deepseek",
            "groq",
            "together",
            "mistral",
            "gemini",
            "ollama",
            "lmstudio"
        ]
    );
    let mut ids = std::collections::HashSet::new();
    for preset in API_PRESETS {
        // The default names pass the same check a user-typed name does, so
        // no preset collides with a built-in provider (`openai`, `ollama`, …).
        validate_provider_id(preset.default_id).expect(preset.default_id);
        assert!(ids.insert(preset.default_id), "{}", preset.default_id);
        // Preset URLs are already in normalized form.
        assert_eq!(
            normalize_base_url(preset.base_url).expect(preset.base_url),
            preset.base_url
        );
        assert_eq!(api_preset(preset.kind), Some(preset));
        assert_eq!(api_preset(&preset.kind.to_uppercase()), Some(preset));
    }
    assert_eq!(
        api_preset("openai").map(|p| p.default_id),
        Some("openai-api")
    );
    assert_eq!(
        api_preset("openrouter").map(|p| p.base_url),
        Some("https://openrouter.ai/api/v1")
    );
    assert_eq!(api_preset("lm-studio").map(|p| p.kind), Some("lmstudio"));
    assert_eq!(api_preset("google").map(|p| p.kind), Some("gemini"));
    assert_eq!(api_preset("custom"), None);
    assert_eq!(api_preset("http://localhost:8000/v1"), None);
    // Cloud APIs need a key; local servers do not. Only OpenAI runs on codex.
    let keyless: Vec<_> = API_PRESETS
        .iter()
        .filter(|preset| !preset.key_required)
        .map(|preset| preset.kind)
        .collect();
    assert_eq!(keyless, ["ollama", "lmstudio"]);
    let codex: Vec<_> = API_PRESETS
        .iter()
        .filter(|preset| preset.codex_engine)
        .map(|preset| preset.kind)
        .collect();
    assert_eq!(codex, ["openai"]);
}

#[test]
fn built_in_names_stay_reserved_for_users_too() {
    for reserved in [
        "unieai",
        "openai",
        "ollama",
        "lmstudio",
        "oss",
        "amazon-bedrock",
    ] {
        let err = validate_provider_id(reserved).expect_err(reserved);
        assert!(err.to_string().contains("built-in"), "{err}");
    }
    assert!(validate_provider_id("openrouter").is_ok());
    assert!(validate_provider_id("openai-api").is_ok());
}

#[test]
fn preset_names_are_made_unique_unless_the_url_is_the_same() {
    let preset = api_preset("openrouter").expect("preset");
    let url = preset.base_url;
    assert_eq!(default_preset_provider_id(preset, url, &[]), "openrouter");
    let same = [provider("openrouter", url, &["a"])];
    assert_eq!(default_preset_provider_id(preset, url, &same), "openrouter");
    let other = [provider("openrouter", "http://proxy/v1", &["a"])];
    assert_eq!(
        default_preset_provider_id(preset, url, &other),
        "openrouter-2"
    );
}

#[test]
fn labels_come_from_the_kind() {
    let mut openrouter = provider("openrouter", "https://openrouter.ai/api/v1", &["x"]);
    openrouter.kind = Some("openrouter".to_string());
    assert_eq!(openrouter.label(), "OpenRouter");
    openrouter.id = "work".to_string();
    assert_eq!(openrouter.label(), "OpenRouter (work)");
    assert!(!openrouter.runs_on_codex_engine());
    assert_eq!(
        openrouter.model_provider_info().namespace_tools,
        Some(false)
    );

    let mut openai = provider("openai-api", "https://api.openai.com/v1", &["gpt-5"]);
    openai.kind = Some("openai".to_string());
    assert_eq!(openai.label(), "OpenAI");
    assert!(openai.runs_on_codex_engine());
    assert_eq!(openai.model_provider_info().namespace_tools, None);

    // Files from before presets, and custom URLs, stay "Self-hosted".
    let legacy = provider("local", "http://localhost:11434/v1", &["q"]);
    assert_eq!(legacy.label(), "Self-hosted: local");
    let mut custom = legacy.clone();
    custom.kind = Some(CUSTOM_KIND.to_string());
    assert_eq!(custom.label(), "Self-hosted: local");
    assert!(!custom.runs_on_codex_engine());
}

#[test]
fn kind_round_trips_and_old_files_still_load() {
    let home = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        self_hosted_path(home.path()),
        r#"{"version":1,"providers":[{"id":"gpu","base_url":"http://gpu:8000/v1","models":[{"id":"m"}]}]}"#,
    )
    .expect("write");
    let old = read_self_hosted_providers(home.path()).expect("old file");
    assert_eq!(old[0].kind, None);

    let mut openrouter = provider("openrouter", "https://openrouter.ai/api/v1", &["x"]);
    openrouter.kind = Some("openrouter".to_string());
    upsert_self_hosted_provider(home.path(), openrouter.clone()).expect("save");
    let raw = std::fs::read_to_string(self_hosted_path(home.path())).expect("read");
    assert!(raw.contains(r#""kind": "openrouter""#), "{raw}");
    // The legacy entry is written back without a kind.
    assert_eq!(raw.matches("\"kind\"").count(), 1, "{raw}");
    assert_eq!(
        read_self_hosted_providers(home.path()).expect("read"),
        vec![old[0].clone(), openrouter]
    );
}

#[test]
fn chat_models_and_filters() {
    for id in ["gpt-5", "deepseek-chat", "qwen2.5:0.5b", "openai/gpt-4o"] {
        assert!(is_chat_model_id(id), "{id}");
    }
    for id in [
        "text-embedding-3-small",
        "nomic-embed-text",
        "whisper-1",
        "tts-1-hd",
        "dall-e-3",
        "omni-moderation-latest",
        "gpt-4o-mini-transcribe",
        "gpt-image-1",
    ] {
        assert!(!is_chat_model_id(id), "{id}");
    }
    assert!(model_matches_filter("anthropic/claude-sonnet-4", ""));
    assert!(model_matches_filter("anthropic/claude-sonnet-4", "Claude"));
    assert!(model_matches_filter(
        "anthropic/claude-sonnet-4",
        "anthropic sonnet"
    ));
    assert!(!model_matches_filter(
        "anthropic/claude-sonnet-4",
        "anthropic opus"
    ));
}

#[test]
fn openrouter_listings_bring_context_windows_and_vision() {
    let body = serde_json::json!({"data": [
        {"id": "openai/gpt-4o", "context_length": 128000,
         "architecture": {"input_modalities": ["text", "image"]}},
        {"id": "deepseek/deepseek-chat", "context_length": 64000,
         "architecture": {"input_modalities": ["text"]}}
    ]});
    assert_eq!(
        parse_models_response(&body),
        Some(vec![
            DiscoveredModel {
                id: "openai/gpt-4o".to_string(),
                context_window: Some(128_000),
                vision: true,
            },
            DiscoveredModel {
                id: "deepseek/deepseek-chat".to_string(),
                context_window: Some(64_000),
                vision: false,
            },
        ])
    );
}

#[tokio::test]
async fn a_preset_stores_its_kind_and_default_name() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/models"))
        .and(header("authorization", "Bearer sk-or"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": [
                {"id": "openai/gpt-4o", "context_length": 128000},
                {"id": "openai/text-embedding-3-small"}
            ]
        })))
        .mount(&server)
        .await;
    let home = tempfile::tempdir().expect("tempdir");
    // The preset's URL is overridden here only to reach the mock.
    let added = add_api_provider(
        home.path(),
        SelfHostedRequest {
            base_url: format!("{}/api/v1", server.uri()),
            kind: Some("OpenRouter".to_string()),
            api_key: Some("sk-or".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("added");
    assert_eq!(added.provider.id, "openrouter");
    assert_eq!(added.provider.kind.as_deref(), Some("openrouter"));
    assert_eq!(added.found, 1, "the embedding model is not a chat model");
    assert_eq!(added.provider.models[0].context_window, Some(128_000));
    assert_eq!(added.provider.label(), "OpenRouter");

    // A custom URL from the new flow says so.
    let custom = add_api_provider(
        home.path(),
        SelfHostedRequest {
            base_url: server.uri(),
            kind: Some(CUSTOM_KIND.to_string()),
            name: Some("box".to_string()),
            models: vec!["m".to_string()],
            ..Default::default()
        },
    )
    .await
    .expect("custom");
    assert_eq!(custom.provider.kind.as_deref(), Some(CUSTOM_KIND));
}

#[tokio::test]
async fn cloud_presets_need_a_key_and_unknown_presets_are_refused() {
    let home = tempfile::tempdir().expect("tempdir");
    let err = add_api_provider(
        home.path(),
        SelfHostedRequest {
            kind: Some("deepseek".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect_err("no key");
    assert!(matches!(err, SelfHostedError::KeyRequired { .. }), "{err}");
    assert!(
        err.to_string().starts_with("DeepSeek needs an API key"),
        "{err}"
    );

    let err = add_api_provider(
        home.path(),
        SelfHostedRequest {
            kind: Some("nope".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect_err("unknown");
    assert!(matches!(err, SelfHostedError::UnknownPreset(_)), "{err}");
    assert!(err.to_string().contains("openrouter"), "{err}");
    assert_eq!(load_self_hosted_providers(home.path()), Vec::new());
}

#[tokio::test]
async fn huge_lists_are_capped_filtered_or_pinned() {
    let data: Vec<_> = (0..120)
        .map(|n| serde_json::json!({"id": format!("vendor{}/model-{n}", n % 3)}))
        .collect();
    let server = models_server(200, serde_json::json!({ "data": data })).await;
    let home = tempfile::tempdir().expect("tempdir");
    let request = |filter: Option<&str>, models: Vec<String>| SelfHostedRequest {
        base_url: server.uri(),
        name: Some("big".to_string()),
        model_filter: filter.map(str::to_string),
        models,
        ..Default::default()
    };

    let all = add_api_provider(home.path(), request(None, Vec::new()))
        .await
        .expect("all");
    assert_eq!(all.found, 120);
    assert_eq!(all.provider.models.len(), MAX_STORED_MODELS);
    assert_eq!(all.provider.models[0].id, "vendor0/model-0");

    let filtered = add_api_provider(home.path(), request(Some("vendor1"), Vec::new()))
        .await
        .expect("filtered");
    assert_eq!(filtered.provider.models.len(), 40);
    assert!(
        filtered
            .provider
            .models
            .iter()
            .all(|m| m.id.starts_with("vendor1/"))
    );

    let err = add_api_provider(home.path(), request(Some("nothing"), Vec::new()))
        .await
        .expect_err("no match");
    assert!(
        matches!(err, SelfHostedError::NoMatchingModels { found: 120, .. }),
        "{err}"
    );

    let pinned = add_api_provider(
        home.path(),
        request(None, vec!["vendor2/model-119".to_string()]),
    )
    .await
    .expect("pinned");
    assert!(pinned.provider.manual_models);
    assert_eq!(pinned.provider.models.len(), 1);
}

#[tokio::test]
async fn a_bad_key_answered_with_400_is_a_key_problem() {
    // Gemini's OpenAI-compatible endpoint answers a wrong key with 400.
    let server = models_server(
        400,
        serde_json::json!({"error": {"code": 400, "message": "Please pass a valid API key"}}),
    )
    .await;
    let err = probe_models(&format!("{}/v1", server.uri()), Some("bad"))
        .await
        .expect_err("400");
    assert!(
        matches!(err, SelfHostedError::Unauthorized { status: 400, .. }),
        "{err}"
    );
}
