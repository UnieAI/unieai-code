import React, { useEffect, useMemo, useState } from 'react'
import { Box, Link, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { Select } from './CustomSelect/select.js'
import { OpenAILoginFlow } from './OpenAILoginFlow.js'
import { Spinner } from './Spinner.js'
import { StartupUpdatePrompt } from './StartupUpdatePrompt.js'
import TextInput from './TextInput.js'
import { UnieAIAuthService, syncUnieAIModelsToCache } from '../services/unieaiAuth/index.js'
import { openBrowser } from '../utils/browser.js'
import { saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

type LoginSelection =
  | 'unieai'
  | 'unieai-company'
  | 'claudeai'
  | 'console'
  | 'openai'
  | 'platform'
  | 'idle'

type UnieAIPhase =
  | { state: 'idle' }
  | { state: 'pending'; userCode: string; verificationUrl: string; studioUrl: string }
  | { state: 'success'; email?: string }
  | { state: 'error'; message: string }

function PlatformSetupFlow({
  onBack,
}: {
  onBack(): void
}): React.ReactNode {
  useKeybinding(
    'confirm:yes',
    () => {
      onBack()
    },
    {
      context: 'Confirmation',
      isActive: true,
    },
  )

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>Using 3rd-party platforms</Text>
      <Text>
        UnieAI Code supports Amazon Bedrock, Microsoft Foundry, and Vertex AI.
        Set the required environment variables, then restart UnieAI Code.
      </Text>
      <Text>
        If you are part of an enterprise organization, contact your
        administrator for setup instructions.
      </Text>
      <Box flexDirection="column">
        <Text bold>Documentation:</Text>
        <Text>
          · Amazon Bedrock:{' '}
          <Link url="https://code.claude.com/docs/en/amazon-bedrock" />
        </Text>
        <Text>
          · Microsoft Foundry:{' '}
          <Link url="https://code.claude.com/docs/en/microsoft-foundry" />
        </Text>
        <Text>
          · Vertex AI:{' '}
          <Link url="https://code.claude.com/docs/en/google-vertex-ai" />
        </Text>
      </Box>
      <Text dimColor>
        Press <Text bold>Enter</Text> to go back to login options.
      </Text>
    </Box>
  )
}

export function SlashLoginFlow({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const settings = getSettings_DEPRECATED() || {}
  const forceLoginMethod = settings.forceLoginMethod

  const [selection, setSelection] = useState<LoginSelection>(() => {
    if (forceLoginMethod === 'claudeai' || forceLoginMethod === 'console') {
      return forceLoginMethod
    }
    return 'idle'
  })

  const [companyStudioUrl, setCompanyStudioUrl] = useState<string | null>(null)
  const [updateGateDone, setUpdateGateDone] = useState(false)

  const options = useMemo(
    () => [
      {
        label: (
          <Text>
            UnieAI Studio ·{' '}
            <Text dimColor>Sign in with your UnieAI Studio account</Text>
            {'\n'}
          </Text>
        ),
        value: 'unieai' as const,
      },
      {
        label: (
          <Text>
            Company UnieAI Studio ·{' '}
            <Text dimColor>Sign in with your company&apos;s Studio URL</Text>
            {'\n'}
          </Text>
        ),
        value: 'unieai-company' as const,
      },
      // UnieAI Code: legacy Anthropic / OpenAI / 3rd-party options removed.
      // Kept commented for restoration if cross-provider login is ever needed.
      // { label: <Text>Claude account with subscription · <Text dimColor>Pro, Max, Team, or Enterprise</Text>{'\n'}</Text>, value: 'claudeai' as const },
      // { label: <Text>Anthropic Console account · <Text dimColor>API usage billing</Text>{'\n'}</Text>, value: 'console' as const },
      // { label: <Text>OpenAI account · <Text dimColor>ChatGPT Pro/Plus</Text>{'\n'}</Text>, value: 'openai' as const },
      // { label: <Text>3rd-party platform · <Text dimColor>Amazon Bedrock, Microsoft Foundry, or Vertex AI</Text>{'\n'}</Text>, value: 'platform' as const },
    ],
    [],
  )

  if (!updateGateDone) {
    return <StartupUpdatePrompt onDone={() => setUpdateGateDone(true)} />
  }

  if (selection === 'unieai') {
    return (
      <UnieAILoginFlow onDone={onDone} onBack={() => setSelection('idle')} />
    )
  }

  if (selection === 'unieai-company') {
    if (companyStudioUrl === null) {
      return (
        <CompanyStudioUrlPrompt
          onSubmit={url => setCompanyStudioUrl(url)}
          onBack={() => setSelection('idle')}
        />
      )
    }
    return (
      <UnieAILoginFlow
        studioUrl={companyStudioUrl}
        onDone={onDone}
        onBack={() => {
          setCompanyStudioUrl(null)
          setSelection('idle')
        }}
      />
    )
  }

  if (selection === 'claudeai' || selection === 'console') {
    return (
      <ConsoleOAuthFlow
        onDone={onDone}
        startingMessage={startingMessage}
        forceLoginMethod={selection}
      />
    )
  }

  if (selection === 'openai') {
    return <OpenAILoginFlow onDone={onDone} startingMessage={startingMessage} />
  }

  if (selection === 'platform') {
    return <PlatformSetupFlow onBack={() => setSelection('idle')} />
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>
        {startingMessage ?? 'Sign in with your UnieAI Studio account to use UnieAI Code.'}
      </Text>
      <Text>Select login method:</Text>
      <Box>
        <Select
          options={options}
          onChange={value => setSelection(value as LoginSelection)}
        />
      </Box>
    </Box>
  )
}

function CompanyStudioUrlPrompt({
  onSubmit,
  onBack,
}: {
  onSubmit(url: string): void
  onBack(): void
}): React.ReactNode {
  const [url, setUrl] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>Sign in to your company&apos;s UnieAI Studio</Text>
      <Text dimColor>
        Paste your company&apos;s UnieAI Studio URL. The login flow and APIs are
        the same as UnieAI Studio.
      </Text>
      <Box>
        <Text>URL: </Text>
        <TextInput
          value={url}
          onChange={setUrl}
          onSubmit={value => {
            const trimmed = value.trim()
            if (trimmed.length === 0) {
              onBack()
              return
            }
            onSubmit(trimmed)
          }}
          focus={true}
          showCursor={true}
          placeholder="https://studio.yourcompany.com"
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
        />
      </Box>
      <Text dimColor>Press Enter to continue · leave empty and press Enter to go back.</Text>
    </Box>
  )
}

function UnieAILoginFlow({
  onDone,
  onBack,
  studioUrl: studioUrlOverride,
}: {
  onDone(): void
  onBack(): void
  studioUrl?: string
}): React.ReactNode {
  const [phase, setPhase] = useState<UnieAIPhase>({ state: 'idle' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const service = new UnieAIAuthService()
      try {
        const result = await service.startDeviceFlow({
          studioUrl: studioUrlOverride,
          onPrompt: ({ userCode, verificationUriComplete, studioUrl }) => {
            if (cancelled) return
            setPhase({
              state: 'pending',
              userCode,
              verificationUrl: verificationUriComplete,
              studioUrl,
            })
          },
          openBrowser: async (url) => {
            await openBrowser(url)
          },
        })
        if (cancelled) return
        if (result.kind === 'success') {
          saveGlobalConfig((current) => ({
            ...current,
            hasCompletedOnboarding: true,
            theme: current.theme ?? 'dark',
          }))
          await syncUnieAIModelsToCache().catch(() => 0)
          setPhase({ state: 'success', email: result.tokens.email })
        } else if (result.kind === 'denied') {
          setPhase({ state: 'error', message: 'UnieAI Studio login was denied.' })
        } else if (result.kind === 'expired') {
          setPhase({
            state: 'error',
            message: 'UnieAI Studio login expired. Please try again.',
          })
        } else {
          setPhase({
            state: 'error',
            message: `UnieAI Studio login failed: ${result.message}`,
          })
        }
      } catch (err) {
        logError(err)
        setPhase({
          state: 'error',
          message: `UnieAI Studio login failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [studioUrlOverride])

  useKeybinding(
    'confirm:yes',
    () => {
      if (phase.state === 'success') {
        onDone()
      } else if (phase.state === 'error') {
        onBack()
      }
    },
    {
      context: 'Confirmation',
      isActive: phase.state === 'success' || phase.state === 'error',
    },
  )

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      {phase.state === 'idle' && (
        <Box><Spinner /><Text> Requesting verification code…</Text></Box>
      )}
      {phase.state === 'pending' && (
        <Box flexDirection="column" gap={1}>
          <Text>
            Sign in to UnieAI Studio (<Text color="#006AFF">{phase.studioUrl}</Text>)
          </Text>
          <Text>
            Open in browser: <Link url={phase.verificationUrl}>{phase.verificationUrl}</Link>
          </Text>
          <Text>
            Verification code:{' '}
            <Text bold color="#006AFF">
              {phase.userCode}
            </Text>
          </Text>
          <Box><Spinner /><Text> Waiting for authorization…</Text></Box>
        </Box>
      )}
      {phase.state === 'success' && (
        <Box flexDirection="column">
          <Text color="green">
            UnieAI Studio login successful{phase.email ? ` as ${phase.email}` : ''}.
          </Text>
          <Text dimColor>
            Press <Text bold>Enter</Text> to continue…
          </Text>
        </Box>
      )}
      {phase.state === 'error' && (
        <Box flexDirection="column">
          <Text color="red">{phase.message}</Text>
          <Text dimColor>
            Press <Text bold>Enter</Text> to go back.
          </Text>
        </Box>
      )}
    </Box>
  )
}
