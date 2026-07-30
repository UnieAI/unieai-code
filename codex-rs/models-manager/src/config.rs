use codex_protocol::config_types::Personality;
use codex_protocol::openai_models::ModelsResponse;

#[derive(Debug, Clone, Default)]
pub struct ModelsManagerConfig {
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub tool_output_token_limit: Option<usize>,
    pub base_instructions: Option<String>,
    pub personality_enabled: bool,
    pub personality: Option<Personality>,
    pub model_catalog: Option<ModelsResponse>,
    /// Treat a slug the catalog does not know as a model the configured gateway
    /// serves, rather than as an unknown model.
    ///
    /// The UnieAI catalog is a snapshot of the models saved at login, while the
    /// gateway routes by slug — so a model the gateway serves perfectly well can
    /// be absent from the catalog (added gateway-side after the last login, or
    /// simply not exposed by Studio for the account). Without this the request
    /// still succeeds, which is what makes the mismatch so easy to miss: the
    /// model just quietly loses its gateway metadata.
    pub unknown_models_are_gateway_models: bool,
}
