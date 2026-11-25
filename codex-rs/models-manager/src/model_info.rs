use codex_protocol::config_types::Personality;
use codex_protocol::config_types::ReasoningSummary;
use codex_protocol::openai_models::ConfigShellToolType;
use codex_protocol::openai_models::InputModality;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelMessages;
use codex_protocol::openai_models::ModelVisibility;
use codex_protocol::openai_models::ReasoningEffort;
use codex_protocol::openai_models::ReasoningEffortPreset;
use codex_protocol::openai_models::ToolMode;
use codex_protocol::openai_models::TruncationMode;
use codex_protocol::openai_models::TruncationPolicyConfig;
use codex_protocol::openai_models::WebSearchToolType;
use codex_protocol::openai_models::default_input_modalities;
use codex_utils_cached_str::CodexCachedStr;

use crate::config::ModelsManagerConfig;
use codex_utils_output_truncation::approx_bytes_for_tokens;
use tracing::warn;

pub const BASE_INSTRUCTIONS: &str = include_str!("../prompt.md");
const PERSONALITY_SECTION_HEADER: &str = "# Personality";

pub fn with_config_overrides(mut model: ModelInfo, config: &ModelsManagerConfig) -> ModelInfo {
    if let Some(context_window) = config.model_context_window {
        model.context_window = Some(
            model
                .max_context_window
                .map_or(context_window, |max_context_window| {
                    context_window.min(max_context_window)
                }),
        );
    }
    if let Some(auto_compact_token_limit) = config.model_auto_compact_token_limit {
        model.auto_compact_token_limit = Some(auto_compact_token_limit);
    }
    if let Some(token_limit) = config.tool_output_token_limit {
        model.truncation_policy = match model.truncation_policy.mode {
            TruncationMode::Bytes => {
                let byte_limit =
                    i64::try_from(approx_bytes_for_tokens(token_limit)).unwrap_or(i64::MAX);
                TruncationPolicyConfig::bytes(byte_limit)
            }
            TruncationMode::Tokens => {
                let limit = i64::try_from(token_limit).unwrap_or(i64::MAX);
                TruncationPolicyConfig::tokens(limit)
            }
        };
    }

    if let Some(base_instructions) = &config.base_instructions {
        let model_messages = model.model_messages.get_or_insert_default();
        model_messages.instructions_template = Some(base_instructions.as_str().into());
    } else if config.personality == Some(Personality::None)
        && let Some(instructions_template) = model
            .model_messages
            .as_mut()
            .and_then(|messages| messages.instructions_template.as_mut())
    {
        strip_personality_section(instructions_template);
    }

    model
}

fn strip_personality_section(instructions: &mut CodexCachedStr) {
    let mut section_start = None;
    let mut section_end = None;
    let mut offset = 0;

    for line_with_ending in instructions.split_inclusive('\n') {
        let line = match line_with_ending.strip_suffix('\n') {
            Some(line) => line.strip_suffix('\r').unwrap_or(line),
            None => line_with_ending,
        };
        if section_start.is_some() {
            if is_h1_heading(line) {
                section_end = Some(offset);
                break;
            }
        } else if line == PERSONALITY_SECTION_HEADER {
            section_start = Some(offset);
        }
        offset += line_with_ending.len();
    }

    if let Some(section_start) = section_start {
        let section_end = section_end.unwrap_or(instructions.len());
        let mut text = String::with_capacity(instructions.len() - (section_end - section_start));
        text.push_str(&instructions[..section_start]);
        text.push_str(&instructions[section_end..]);
        *instructions = text.into();
    }
}

fn is_h1_heading(line: &str) -> bool {
    let Some(rest) = line.strip_prefix('#') else {
        return false;
    };
    rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t')
}

/// Build a minimal fallback model descriptor for missing/unknown slugs.
pub fn model_info_from_slug(slug: &str) -> ModelInfo {
    warn!("Unknown model {slug} is used. This will use fallback model metadata.");
    base_model_info(slug)
}

// Source of truth intent: this prompt is slated to live in
// github.com/unieai/unieai-agent-core as its coding profile (same layered
// style as that repo's prompt.mjs); sync the .md file from there once merged.
const GATEWAY_BASE_INSTRUCTIONS: &str = include_str!("gateway_instructions.md");

/// Build a descriptor for a model served by an external OpenAI-compatible
/// gateway (e.g. a UnieAI inference gateway). Uses the same conservative
/// defaults as the fallback path, but the model is picker-visible and not
/// flagged as fallback metadata, and the gateway may supply a display name
/// and context window.
pub fn model_info_for_gateway_model(
    slug: &str,
    display_name: &str,
    context_window: Option<i64>,
    input_modalities: Option<&[String]>,
    reasoning_levels: Option<&[String]>,
) -> ModelInfo {
    let mut info = base_model_info(slug);
    info.display_name = display_name.to_string();
    info.visibility = ModelVisibility::List;
    // Open models speak plain function calling best: pin Direct so feature
    // flags can't switch them into code-mode, and don't send the OpenAI
    // reasoning-summary parameter their gateways ignore.
    info.tool_mode = Some(ToolMode::Direct);
    info.supports_reasoning_summary_parameter = false;
    let (default_reasoning_level, supported_reasoning_levels) =
        gateway_reasoning_ladder(slug, reasoning_levels);
    info.default_reasoning_level = default_reasoning_level;
    info.supported_reasoning_levels = supported_reasoning_levels;
    info.model_messages
        .get_or_insert_with(local_model_messages)
        .instructions_template = Some(GATEWAY_BASE_INSTRUCTIONS.into());
    if let Some(context_window) = context_window {
        info.context_window = Some(context_window);
        info.max_context_window = Some(context_window);
    }
    // Unknown models default to accepting images; a gateway that says a model
    // is text-only must win, or view_image sends images the model rejects.
    if let Some(declared) = input_modalities {
        let modalities: Vec<InputModality> = declared
            .iter()
            .filter_map(|modality| match modality.as_str() {
                "text" => Some(InputModality::Text),
                "image" => Some(InputModality::Image),
                "audio" => Some(InputModality::Audio),
                _ => None,
            })
            .collect();
        if !modalities.is_empty() {
            info.input_modalities = modalities;
        }
    }
    info
}

/// Levels a DeepSeek V4 model on the UnieAI gateway accepts, shallow first.
///
/// Verified against the gateway: it answers 400 with "DeepSeek V4.1 reasoning
/// effort must be none, low, high, xhigh, max or an integer budget from 1 to
/// 100 (minimal and medium aliases are accepted)" for anything else, and the
/// same prompt reasons visibly longer on `high` than on `low`.
const GATEWAY_DEEPSEEK_V4_LEVELS: [(&str, &str); 7] = [
    ("none", "Answer without deliberating first"),
    ("minimal", "Think briefly"),
    ("low", "Light reasoning"),
    ("medium", "Balanced reasoning"),
    ("high", "Deep reasoning"),
    ("xhigh", "Very deep reasoning"),
    ("max", "Deepest reasoning, slowest"),
];

/// The reasoning dial a gateway model offers, and where it starts.
///
/// The gateway's own model metadata wins when it names levels. Until a
/// deployment publishes them, DeepSeek V4 reasoning models get the ladder the
/// gateway validates on `reasoning_effort`; every other model offers nothing,
/// so the picker and the shortcuts stay hidden instead of sending a parameter
/// the model would ignore. `agent-runtime/src/unieai-rabi/config.mjs` declares
/// the same ladder to the Rabi Harness; keep the two in step.
pub fn gateway_reasoning_ladder(
    slug: &str,
    declared: Option<&[String]>,
) -> (Option<ReasoningEffort>, Vec<ReasoningEffortPreset>) {
    let declared: Vec<String> = declared
        .unwrap_or_default()
        .iter()
        .map(|level| level.trim().to_ascii_lowercase())
        .filter(|level| !level.is_empty())
        .collect();
    let levels: Vec<(&str, String)> = if declared.is_empty() {
        let slug = slug.to_ascii_lowercase();
        if !slug.starts_with("deepseek-v4") {
            return (None, Vec::new());
        }
        GATEWAY_DEEPSEEK_V4_LEVELS
            .iter()
            .map(|(level, description)| (*level, (*description).to_string()))
            .collect()
    } else {
        // A level the gateway invented is still a level it accepts; it just
        // carries no local description.
        declared
            .iter()
            .map(|level| (level.as_str(), level.clone()))
            .collect()
    };
    let presets: Vec<ReasoningEffortPreset> = levels
        .iter()
        .map(|(level, description)| ReasoningEffortPreset {
            effort: level.parse().unwrap_or(ReasoningEffort::Medium),
            description: description.clone(),
        })
        .collect();
    // Start in the middle of whatever ladder the model offers: the gateway's
    // own `medium` alias when present, else the midpoint of the list.
    let default = presets
        .iter()
        .find(|preset| preset.effort == ReasoningEffort::Medium)
        .or_else(|| presets.get(presets.len() / 2))
        .map(|preset| preset.effort.clone());
    (default, presets)
}

fn base_model_info(slug: &str) -> ModelInfo {
    ModelInfo {
        slug: slug.to_string(),
        display_name: slug.to_string(),
        description: None,
        default_reasoning_level: None,
        supported_reasoning_levels: Vec::new(),
        shell_type: ConfigShellToolType::UnifiedExec,
        visibility: ModelVisibility::None,
        supported_in_api: true,
        priority: 99,
        additional_speed_tiers: Vec::new(),
        service_tiers: Vec::new(),
        default_service_tier: None,
        available_access_programs: None,
        availability_nux: None,
        upgrade: None,
        model_messages: Some(local_model_messages()),
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
        supports_reasoning_summary_parameter: true,
        default_reasoning_summary: ReasoningSummary::Auto,
        support_verbosity: false,
        default_verbosity: None,
        apply_patch_tool_type: None,
        web_search_tool_type: WebSearchToolType::Text,
        truncation_policy: TruncationPolicyConfig::bytes(/*limit*/ 10_000),
        supports_image_detail_original: false,
        context_window: Some(272_000),
        max_context_window: Some(272_000),
        auto_compact_token_limit: None,
        comp_hash: None,
        effective_context_window_percent: 95,
        experimental_supported_tools: Vec::new(),
        input_modalities: default_input_modalities(),
        supports_search_tool: false,
        supports_experimental_context: false,
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        guardian: None,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        auto_review_model_override: None,
        model_specialty: None,
        tool_mode: None,
        multi_agent_version: None,
        multi_agent_reasoning_effort: None,
        multi_agent_tools_in_code_mode: None,
    }
}

fn local_model_messages() -> ModelMessages {
    ModelMessages {
        instructions_template: Some(BASE_INSTRUCTIONS.into()),
        ..Default::default()
    }
}

#[cfg(test)]
#[path = "model_info_tests.rs"]
mod tests;
