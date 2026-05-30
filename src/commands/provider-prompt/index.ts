import type { Command } from '../../commands.js'

const providerPrompt = {
  type: 'local-jsx',
  name: 'provider-prompt',
  description: 'Set the base system prompt style for non-Claude models',
  argumentHint: '[style]',
  load: () => import('./provider-prompt.js'),
} satisfies Command

export default providerPrompt
