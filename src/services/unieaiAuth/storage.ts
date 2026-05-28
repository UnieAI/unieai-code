import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import memoize from 'lodash-es/memoize.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { UnieAITokens } from './types.js'

function getConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function getStoragePath(): string {
  return join(getConfigDir(), 'unieai-auth.json')
}

export function saveUnieAITokens(tokens: UnieAITokens): {
  success: boolean
  warning?: string
} {
  try {
    const filePath = getStoragePath()
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(tokens, null, 2), { encoding: 'utf8' })
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // chmod is best-effort on non-POSIX
    }
    clearUnieAITokenCache()
    return { success: true }
  } catch (error) {
    logError(error)
    return {
      success: false,
      warning: `Failed to save UnieAI Studio tokens: ${errorMessage(error)}`,
    }
  }
}

export const getUnieAITokens = memoize((): UnieAITokens | null => {
  try {
    const filePath = getStoragePath()
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as UnieAITokens
  } catch (error) {
    logError(error)
    return null
  }
})

export async function getUnieAITokensAsync(): Promise<UnieAITokens | null> {
  return getUnieAITokens()
}

export function clearUnieAITokenCache(): void {
  getUnieAITokens.cache?.clear?.()
}

export function deleteUnieAITokens(): boolean {
  try {
    const filePath = getStoragePath()
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    clearUnieAITokenCache()
    return true
  } catch (error) {
    logError(error)
    return false
  }
}
