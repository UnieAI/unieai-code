/**
 * Provider-specific base system prompts for non-Claude models.
 *
 * The prompt texts are faithfully ported from opencode
 * (https://github.com/sst/opencode), rebranded to "UnieAI Code". They live as
 * .txt assets under ./providerPrompts/ and are imported here as text (Bun
 * `with { type: 'text' }`, the same mechanism opencode itself uses).
 *
 * These replace getSimpleIntroSection() for non-Claude models so that the
 * model gets an appropriate behavioral baseline before cc-haha's tool guidance
 * sections are appended. The common safety guardrails (cyber risk + URL guard)
 * are still appended by the caller (see prompts.ts / COMMON_INTRO_GUARDRAILS).
 */

import PROMPT_ANTHROPIC from './providerPrompts/anthropic.txt' with { type: 'text' }
import PROMPT_BEAST from './providerPrompts/beast.txt' with { type: 'text' }
import PROMPT_CODEX from './providerPrompts/codex.txt' with { type: 'text' }
import PROMPT_COPILOT_GPT5 from './providerPrompts/copilot-gpt-5.txt' with { type: 'text' }
import PROMPT_DEFAULT from './providerPrompts/default.txt' with { type: 'text' }
import PROMPT_GEMINI from './providerPrompts/gemini.txt' with { type: 'text' }
import PROMPT_GPT from './providerPrompts/gpt.txt' with { type: 'text' }
import PROMPT_KIMI from './providerPrompts/kimi.txt' with { type: 'text' }
import PROMPT_TRINITY from './providerPrompts/trinity.txt' with { type: 'text' }

// Contextual prompts (injected by prompts.ts as dynamic sections, not as the
// base intro). Exported for reuse.
import PROMPT_PLAN_MODE from './providerPrompts/plan-mode.txt' with { type: 'text' }
import PROMPT_PLAN_REMINDER from './providerPrompts/plan-reminder-anthropic.txt' with { type: 'text' }
import PROMPT_MAX_STEPS from './providerPrompts/max-steps.txt' with { type: 'text' }

// Style metadata lives in a .txt-free module so settings validation can import
// the value list without pulling in the prompt texts. Re-exported here so
// existing importers of './providerPrompt.js' keep working.
import {
  PROVIDER_PROMPT_OPTIONS,
  PROVIDER_PROMPT_STYLE_VALUES,
  type ProviderPromptStyle,
} from './providerPromptStyles.js'

export {
  PROVIDER_PROMPT_OPTIONS,
  PROVIDER_PROMPT_STYLE_VALUES,
  type ProviderPromptStyle,
}

export const PROVIDER_CONTEXTUAL_PROMPTS = {
  planMode: PROMPT_PLAN_MODE,
  planReminder: PROMPT_PLAN_REMINDER,
  maxSteps: PROMPT_MAX_STEPS,
} as const

/**
 * style → base prompt text. Keys (other than 'auto'/'claude') must match the
 * `value`s in PROVIDER_PROMPT_OPTIONS. 'claude' is intentionally absent: it
 * resolves to null (cc-haha's native prompt) in getProviderBasePrompt.
 */
export const PROVIDER_PROMPT_MAP: Record<string, string> = {
  anthropic: PROMPT_ANTHROPIC,
  beast: PROMPT_BEAST,
  codex: PROMPT_CODEX,
  'copilot-gpt-5': PROMPT_COPILOT_GPT5,
  gpt: PROMPT_GPT,
  gemini: PROMPT_GEMINI,
  kimi: PROMPT_KIMI,
  trinity: PROMPT_TRINITY,
  default: PROMPT_DEFAULT,
}

/**
 * Returns the provider-specific base prompt string, or null for Claude models
 * (which use cc-haha's native system prompt).
 *
 * Auto-detection mirrors opencode's session/system.ts `provider()` so behavior
 * matches the upstream prompts these texts came from.
 *
 * @param modelId - The model ID string (e.g. "gpt-4o", "qwen2.5-72b")
 * @param style   - User setting from settings.providerPromptStyle ('auto' | ...)
 */
export function getProviderBasePrompt(
  modelId: string,
  style?: string | null,
): string | null {
  // Explicit override (non-auto)
  if (style && style !== 'auto') {
    if (style === 'claude') return null
    return PROVIDER_PROMPT_MAP[style] ?? PROMPT_DEFAULT
  }

  // Auto-detect by model ID (faithful to opencode's provider() ordering).
  const id = (modelId ?? '').toLowerCase()
  if (id.includes('claude')) return null // use native cc-haha prompt
  if (id.includes('gpt-4') || id.includes('o1') || id.includes('o3'))
    return PROMPT_BEAST
  if (id.includes('gpt')) {
    if (id.includes('codex')) return PROMPT_CODEX
    return PROMPT_GPT
  }
  if (id.includes('gemini-')) return PROMPT_GEMINI
  if (id.includes('trinity')) return PROMPT_TRINITY
  if (id.includes('kimi') || id.includes('moonshot')) return PROMPT_KIMI
  // Default for everything else (Llama, Qwen, DeepSeek, Mistral, etc.)
  return PROMPT_DEFAULT
}
