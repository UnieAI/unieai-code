import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  PROVIDER_PROMPT_OPTIONS,
  PROVIDER_PROMPT_STYLE_VALUES,
  type ProviderPromptStyle,
} from '../../constants/providerPrompt.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

type Props = {
  onDone: LocalJSXCommandOnDone
  initialStyle: ProviderPromptStyle
}

/** Persist the chosen style to user settings, preserving other keys. */
function persistProviderPromptStyle(style: string): void {
  const existing = getSettingsForSource('userSettings') ?? {}
  updateSettingsForSource('userSettings', {
    ...existing,
    providerPromptStyle: style,
  })
}

function ProviderPromptPicker({ onDone, initialStyle }: Props): React.ReactNode {
  const options = PROVIDER_PROMPT_OPTIONS.map(o => ({
    value: o.value,
    label: o.label,
    description: o.description,
  }))

  function handleChange(value: string) {
    persistProviderPromptStyle(value)
    onDone(`Provider prompt set to "${value}". Takes effect next session.`, {
      display: 'system',
    })
  }

  function handleCancel() {
    onDone(undefined, { display: 'system' })
  }

  return (
    <Box flexDirection="column">
      <Text bold>Select provider prompt style for non-Claude models:</Text>
      <Select
        options={options}
        defaultValue={initialStyle}
        onChange={handleChange}
        onCancel={handleCancel}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const style = args.trim()
  const validValues = PROVIDER_PROMPT_STYLE_VALUES as readonly string[]

  // Direct set via argument: /provider-prompt beast
  if (style && validValues.includes(style)) {
    persistProviderPromptStyle(style)
    onDone(`Provider prompt set to "${style}". Takes effect next session.`, {
      display: 'system',
    })
    return null
  }

  if (style && !validValues.includes(style)) {
    onDone(`Unknown style "${style}". Available: ${validValues.join(', ')}`, {
      display: 'system',
    })
    return null
  }

  const current = (getSettingsForSource('userSettings')?.providerPromptStyle ??
    'auto') as ProviderPromptStyle

  return <ProviderPromptPicker onDone={onDone} initialStyle={current} />
}
