// Copyright (c) 2026 UnieAI. All rights reserved.
//! Connected model APIs (`unieai login --api`, self-hosted servers
//! included) in the config: each is a model provider of its own id, and its
//! models join the UnieAI model catalog as `<provider id>/<model id>` so the
//! /model picker lists them beside the Studio account's, labelled with the
//! API they run on ("OpenRouter", "Self-hosted: gpu").

use std::collections::HashMap;

use codex_login::unieai_self_hosted::DEFAULT_SELF_HOSTED_CONTEXT_WINDOW;
use codex_login::unieai_self_hosted::SelfHostedProvider;
use codex_model_provider_info::ModelProviderInfo;
use codex_protocol::openai_models::ModelInfo;

/// Declares each server as a provider, unless config.toml already defines
/// one of that id (`[model_providers.<id>]` wins).
pub(crate) fn add_self_hosted_model_providers(
    model_providers: &mut HashMap<String, ModelProviderInfo>,
    servers: &[SelfHostedProvider],
) {
    for server in servers {
        model_providers
            .entry(server.id.clone())
            .or_insert_with(|| server.model_provider_info());
    }
}

/// The catalog entries for `servers`' models. `qualified` names them
/// `<provider id>/<model id>` (beside the UnieAI gateway's models); a
/// session whose provider is the server itself uses the bare ids.
pub(crate) fn self_hosted_catalog_models(
    servers: &[SelfHostedProvider],
    qualified: bool,
) -> Vec<ModelInfo> {
    servers
        .iter()
        .flat_map(|server| {
            server.models.iter().map(move |model| {
                let slug = if qualified {
                    server.slug(&model.id)
                } else {
                    model.id.clone()
                };
                let modalities: Vec<String> = if model.vision {
                    vec!["text".to_string(), "image".to_string()]
                } else {
                    vec!["text".to_string()]
                };
                let mut info = codex_models_manager::model_info::model_info_for_gateway_model(
                    &slug,
                    &model.id,
                    Some(
                        model
                            .context_window
                            .unwrap_or(DEFAULT_SELF_HOSTED_CONTEXT_WINDOW),
                    ),
                    Some(&modalities),
                );
                // "OpenAI", "OpenRouter", …, or "Self-hosted: <name>".
                info.description = Some(server.label());
                info
            })
        })
        .collect()
}

/// The configured server whose id is `provider_id`, if any.
pub(crate) fn self_hosted_server<'a>(
    servers: &'a [SelfHostedProvider],
    provider_id: &str,
) -> Option<&'a SelfHostedProvider> {
    servers.iter().find(|server| server.id == provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_login::unieai_self_hosted::SelfHostedModel;
    use codex_protocol::openai_models::InputModality;
    use pretty_assertions::assert_eq;

    fn server() -> SelfHostedProvider {
        SelfHostedProvider {
            id: "gpu".to_string(),
            name: None,
            base_url: "http://gpu:8000/v1".to_string(),
            api_key: Some("sk-secret".to_string()),
            api_key_env: None,
            models: vec![
                SelfHostedModel {
                    id: "Qwen/Qwen3-8B".to_string(),
                    context_window: Some(40_960),
                    vision: false,
                },
                SelfHostedModel {
                    id: "llava".to_string(),
                    context_window: None,
                    vision: true,
                },
            ],
            manual_models: false,
            kind: None,
        }
    }

    #[test]
    fn catalog_entries_carry_the_server_window_and_modalities() {
        let models = self_hosted_catalog_models(&[server()], /*qualified*/ true);
        let slugs: Vec<_> = models.iter().map(|m| m.slug.as_str()).collect();
        assert_eq!(slugs, ["gpu/Qwen/Qwen3-8B", "gpu/llava"]);
        assert_eq!(models[0].display_name, "Qwen/Qwen3-8B");
        assert_eq!(models[0].description.as_deref(), Some("Self-hosted: gpu"));
        assert_eq!(models[0].context_window, Some(40_960));
        assert_eq!(models[0].input_modalities, vec![InputModality::Text]);
        // Unknown windows get the conservative default.
        assert_eq!(
            models[1].context_window,
            Some(DEFAULT_SELF_HOSTED_CONTEXT_WINDOW)
        );
        assert_eq!(
            models[1].input_modalities,
            vec![InputModality::Text, InputModality::Image]
        );

        let bare = self_hosted_catalog_models(&[server()], /*qualified*/ false);
        assert_eq!(bare[1].slug, "llava");
    }

    #[test]
    fn preset_providers_are_labelled_by_their_kind() {
        let openrouter = SelfHostedProvider {
            id: "openrouter".to_string(),
            kind: Some("openrouter".to_string()),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            ..server()
        };
        let openai = SelfHostedProvider {
            id: "openai-api".to_string(),
            kind: Some("openai".to_string()),
            base_url: "https://api.openai.com/v1".to_string(),
            ..server()
        };
        let models = self_hosted_catalog_models(&[openrouter, openai], /*qualified*/ true);
        let labels: Vec<_> = models
            .iter()
            .map(|m| (m.slug.as_str(), m.description.as_deref()))
            .collect();
        assert_eq!(
            labels,
            [
                ("openrouter/Qwen/Qwen3-8B", Some("OpenRouter")),
                ("openrouter/llava", Some("OpenRouter")),
                ("openai-api/Qwen/Qwen3-8B", Some("OpenAI")),
                ("openai-api/llava", Some("OpenAI")),
            ]
        );
    }

    #[test]
    fn configured_providers_win_over_servers_of_the_same_id() {
        let mut providers = HashMap::new();
        add_self_hosted_model_providers(&mut providers, &[server()]);
        assert_eq!(
            providers["gpu"].base_url.as_deref(),
            Some("http://gpu:8000/v1")
        );

        let mut configured = HashMap::from([(
            "gpu".to_string(),
            ModelProviderInfo {
                name: "mine".to_string(),
                base_url: Some("http://elsewhere/v1".to_string()),
                ..Default::default()
            },
        )]);
        add_self_hosted_model_providers(&mut configured, &[server()]);
        assert_eq!(configured["gpu"].name, "mine");
        assert!(self_hosted_server(&[server()], "gpu").is_some());
        assert!(self_hosted_server(&[server()], "unieai").is_none());
    }
}
