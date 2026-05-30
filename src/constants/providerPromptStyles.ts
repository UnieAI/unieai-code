/**
 * Provider-prompt style metadata (single source of truth).
 *
 * Kept free of any .txt asset imports so low-level modules (e.g. settings
 * schema validation) can depend on the list of valid style values without
 * pulling in the prompt texts themselves. The actual prompt texts and
 * selection logic live in ./providerPrompt.ts.
 */

/**
 * Valid style values, as a const tuple so it can be passed directly to
 * z.enum() for settings validation.
 */
export const PROVIDER_PROMPT_STYLE_VALUES = [
  'auto',
  'claude',
  'beast',
  'gpt',
  'codex',
  'copilot-gpt-5',
  'gemini',
  'kimi',
  'trinity',
  'anthropic',
  'default',
] as const

export type ProviderPromptStyle = (typeof PROVIDER_PROMPT_STYLE_VALUES)[number]

export const PROVIDER_PROMPT_OPTIONS: {
  value: ProviderPromptStyle
  label: string
  description: string
}[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Detect by model ID (Claude → native, GPT → beast/gpt, etc.)',
  },
  {
    value: 'claude',
    label: 'Claude (native)',
    description: "Use cc-haha's native system prompt (no provider override)",
  },
  {
    value: 'beast',
    label: 'Beast',
    description: 'Autonomous, thorough — keep going until problem is solved',
  },
  {
    value: 'gpt',
    label: 'GPT',
    description: 'Pragmatic, direct senior engineer style',
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex / gpt-*-codex style',
  },
  {
    value: 'copilot-gpt-5',
    label: 'Copilot GPT-5',
    description: 'Copilot gpt-5 variant',
  },
  {
    value: 'gemini',
    label: 'Gemini',
    description: 'Rigorous, minimal changes, convention-following',
  },
  {
    value: 'kimi',
    label: 'Kimi',
    description: 'General purpose, parallel tool calls encouraged',
  },
  {
    value: 'trinity',
    label: 'Trinity',
    description: 'Trinity model base prompt',
  },
  {
    value: 'anthropic',
    label: 'Anthropic (opencode)',
    description: "opencode's Claude-family prompt (even on non-Claude models)",
  },
  {
    value: 'default',
    label: 'Default (minimal)',
    description: 'Minimal, concise — for simple or restricted models',
  },
]
