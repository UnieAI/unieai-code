// Copyright (c) 2026 UnieAI. All rights reserved.
use super::*;
use crate::unieai::load_unieai_credentials;
use pretty_assertions::assert_eq;

#[test]
fn gateway_is_the_desktop_relay() {
    assert_eq!(
        rabi_gateway_url("https://agent.unieai.com/"),
        "https://agent.unieai.com/api/desktop/v1"
    );
}

#[test]
fn rabi_url_override_is_normalized() {
    assert_eq!(
        resolve_rabi_url(Some("agent.demo.unieai.com/")),
        "https://agent.demo.unieai.com"
    );
}

#[test]
fn entitlements_become_models_in_order_without_duplicates_or_custom_models() {
    let list: EntitledModels = serde_json::from_value(serde_json::json!({
        "models": [
            {"value": "p-qwen", "label": "qwen", "acceptsImages": true, "source": "group"},
            {"value": "p-qwen", "label": "qwen"},
            {"value": "", "label": "nameless"},
            {"value": "p-helper", "label": "helper", "modelType": "custom_model"},
            {"value": "glm", "label": "glm", "modelType": "base_model"}
        ]
    }))
    .expect("parse");
    let models = models_from_entitlements(list.models);
    assert_eq!(
        models,
        vec![
            UnieAIModel {
                id: "p-qwen".to_string(),
                name: Some("qwen".to_string()),
                context_window: None,
                input_modalities: Some(vec!["text".to_string(), "image".to_string()]),
            },
            UnieAIModel {
                id: "glm".to_string(),
                name: None,
                context_window: None,
                input_modalities: Some(vec!["text".to_string()]),
            },
        ]
    );
}

#[test]
fn poll_answers_parse() {
    let approved: DevicePoll = serde_json::from_value(serde_json::json!({
        "status": "approved",
        "api_key": "rk-1",
        "user": {"id": "u1", "name": "U", "email": "u@example.com"}
    }))
    .expect("parse");
    assert_eq!(approved.api_key.as_deref(), Some("rk-1"));
    assert_eq!(approved.user.expect("user").id, "u1");
    let pending: DevicePoll =
        serde_json::from_value(serde_json::json!({"status": "pending", "retryAfterSeconds": 7}))
            .expect("parse");
    assert_eq!(pending.retry_after_seconds, Some(7));
}

#[test]
fn user_code_is_query_safe() {
    assert_eq!(urlencoding_component("3Q4A-AU7X"), "3Q4A-AU7X");
    assert_eq!(urlencoding_component("a b&"), "a%20b%26");
}

#[test]
fn rabi_credentials_round_trip_and_gate_codex() {
    let dir = tempfile::tempdir().expect("tempdir");
    let credentials = UnieAICredentials {
        account: UnieAIAccountKind::Rabi,
        studio_url: DEFAULT_RABI_URL.to_string(),
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: NO_EXPIRY,
        email: Some("u@example.com".to_string()),
        active_org_id: None,
        gateway_base_url: rabi_gateway_url(DEFAULT_RABI_URL),
        gateway_api_key: "rk-1".to_string(),
        gateway_base_url_locked: true,
        available_model_ids: None,
        available_models: Some(Vec::new()),
    };
    save_unieai_credentials(dir.path(), &credentials).expect("save");
    let text = std::fs::read_to_string(dir.path().join("unieai.json")).expect("read");
    assert!(text.contains("\"account\": \"rabi\""), "{text}");
    let loaded = load_unieai_credentials(dir.path()).expect("load");
    assert_eq!(loaded, credentials);
    assert!(!loaded.account.supports_codex_engine());
}
