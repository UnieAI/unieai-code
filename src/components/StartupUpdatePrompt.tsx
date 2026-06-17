import React, { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/select.js'
import { Spinner } from './Spinner.js'
import { getLatestVersion, installGlobalPackage } from '../utils/autoUpdater.js'
import { logError } from '../utils/log.js'
import { gte } from '../utils/semver.js'

type Phase =
  | { state: 'checking' }
  | { state: 'available'; latest: string }
  | { state: 'updating'; latest: string }
  | { state: 'updated'; latest: string }
  | { state: 'error'; latest: string; message: string }

/**
 * Startup gate that checks npm for a newer @unieai/code version. When one is
 * available the user chooses to update (install + exit so the next launch runs
 * the new version) or skip. Best-effort: any failure during the check falls
 * straight through to `onDone()`.
 */
export function StartupUpdatePrompt({
  onDone,
}: {
  onDone(): void
}): React.ReactNode {
  const [phase, setPhase] = useState<Phase>({ state: 'checking' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const latest = await getLatestVersion('latest')
        if (cancelled) return
        if (!latest || gte(MACRO.VERSION, latest)) {
          onDone()
          return
        }
        setPhase({ state: 'available', latest })
      } catch (err) {
        logError(err)
        onDone()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function runUpdate(latest: string): Promise<void> {
    setPhase({ state: 'updating', latest })
    try {
      const status = await installGlobalPackage(latest)
      if (status === 'success' || status === 'in_progress') {
        setPhase({ state: 'updated', latest })
        setTimeout(() => process.exit(0), 1200)
      } else {
        setPhase({
          state: 'error',
          latest,
          message: `Update did not complete (${status}). Run: npm i -g @unieai/code@latest`,
        })
      }
    } catch (err) {
      logError(err)
      setPhase({
        state: 'error',
        latest,
        message: `Update failed. Run: npm i -g @unieai/code@latest`,
      })
    }
  }

  if (phase.state === 'checking') {
    return (
      <Box marginTop={1}>
        <Spinner />
        <Text> Checking for updates…</Text>
      </Box>
    )
  }

  if (phase.state === 'updating') {
    return (
      <Box marginTop={1}>
        <Spinner />
        <Text> Updating to v{phase.latest}…</Text>
      </Box>
    )
  }

  if (phase.state === 'updated') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="success">
          Updated to v{phase.latest}. Restarting — run `unieai` again.
        </Text>
      </Box>
    )
  }

  if (phase.state === 'error') {
    return (
      <Box flexDirection="column" gap={1} marginTop={1}>
        <Text color="error">{phase.message}</Text>
        <Select
          options={[{ label: <Text>Continue</Text>, value: 'skip' as const }]}
          onChange={() => onDone()}
        />
      </Box>
    )
  }

  // phase.state === 'available'
  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>
        A new version of UnieAI Code is available:{' '}
        <Text color="suggestion">v{phase.latest}</Text>{' '}
        <Text dimColor>(current v{MACRO.VERSION})</Text>
      </Text>
      <Select
        options={[
          {
            label: (
              <Text>
                Update now and restart ·{' '}
                <Text dimColor>install v{phase.latest}, then relaunch</Text>
                {'\n'}
              </Text>
            ),
            value: 'update' as const,
          },
          {
            label: (
              <Text>
                Skip for now ·{' '}
                <Text dimColor>keep using v{MACRO.VERSION}</Text>
                {'\n'}
              </Text>
            ),
            value: 'skip' as const,
          },
        ]}
        onChange={value => {
          if (value === 'update') {
            void runUpdate(phase.latest)
          } else {
            onDone()
          }
        }}
      />
    </Box>
  )
}
