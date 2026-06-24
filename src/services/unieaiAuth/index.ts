import {
  DEFAULT_STUDIO_URL,
  deleteSessionRuntimeKey,
  exchangeDeviceCode,
  fetchConfig,
  fetchOrgs,
  fetchUser,
  normalizeGatewayUrl,
  normalizeStudioUrl,
  refreshAccessToken,
  requestDeviceCode,
  resolveGatewayBaseURL,
  resolveStudioUrl,
  revokeRefreshToken,
} from './fetch.js'
import {
  clearUnieAITokenCache,
  deleteUnieAITokens,
  getUnieAITokens,
  getUnieAITokensAsync,
  saveUnieAITokens,
} from './storage.js'
import type {
  UnieAIDeviceAuthResponse,
  UnieAIOrg,
  UnieAIRemoteConfig,
  UnieAITokens,
  UnieAIUser,
} from './types.js'

const REFRESH_LEEWAY_MS = 5 * 60 * 1000

export function isUnieAITokenExpired(expiresAt: number): boolean {
  return expiresAt - Date.now() <= REFRESH_LEEWAY_MS
}

export function shouldUseUnieAIAuth(): boolean {
  const tokens = getUnieAITokens()
  return !!tokens?.refreshToken
}

export type DevicePollResult =
  | { kind: 'success'; tokens: UnieAITokens }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error'; message: string }

export type StartDeviceFlowOptions = {
  studioUrl?: string
  // Explicit inference gateway URL, typed by the user at company login. Stored
  // on the tokens (locked) so it survives the post-login model sync.
  gatewayUrl?: string
  onPrompt?: (info: {
    userCode: string
    verificationUriComplete: string
    studioUrl: string
  }) => void | Promise<void>
  openBrowser?: (url: string) => Promise<void> | void
  pollSignal?: AbortSignal
}

export class UnieAIAuthService {
  async startDeviceFlow(options: StartDeviceFlowOptions = {}): Promise<DevicePollResult> {
    const studioUrl = resolveStudioUrl(options.studioUrl)
    const device = await requestDeviceCode(studioUrl)

    const verificationUri = absoluteVerificationUri(studioUrl, device)
    await options.onPrompt?.({
      userCode: device.user_code,
      verificationUriComplete: verificationUri,
      studioUrl,
    })

    if (options.openBrowser) {
      try {
        await options.openBrowser(verificationUri)
      } catch {
        // browser open is best-effort; user can still visit manually
      }
    }

    return await pollUntilFinal(
      studioUrl,
      device,
      options.pollSignal,
      options.gatewayUrl,
    )
  }

  async ensureFreshTokens(): Promise<UnieAITokens | null> {
    clearUnieAITokenCache()
    const tokens = await getUnieAITokensAsync()
    if (!tokens) return null
    if (!isUnieAITokenExpired(tokens.expiresAt)) return tokens

    const refreshed = await refreshAccessToken(tokens.studioUrl, tokens.refreshToken)
    const updated: UnieAITokens = {
      ...tokens,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    }
    const result = saveUnieAITokens(updated)
    if (!result.success) {
      throw new Error(result.warning ?? 'Failed to persist refreshed UnieAI tokens')
    }
    return updated
  }

  async ensureFreshAccessToken(): Promise<string | null> {
    const tokens = await this.ensureFreshTokens()
    return tokens?.accessToken ?? null
  }

  async getOrgs(): Promise<UnieAIOrg[]> {
    const tokens = await this.ensureFreshTokens()
    if (!tokens) throw new Error('Not logged in to UnieAI Studio.')
    return fetchOrgs(tokens.studioUrl, tokens.accessToken)
  }

  async getConfig(orgId?: string): Promise<UnieAIRemoteConfig | null> {
    const tokens = await this.ensureFreshTokens()
    if (!tokens) throw new Error('Not logged in to UnieAI Studio.')
    const targetOrg = orgId ?? tokens.activeOrgId
    if (!targetOrg) {
      throw new Error('No active organization. Run "claude auth orgs --unieai" to pick one.')
    }
    return fetchConfig(tokens.studioUrl, tokens.accessToken, targetOrg)
  }

  async setActiveOrg(orgId: string): Promise<UnieAITokens> {
    const tokens = await this.ensureFreshTokens()
    if (!tokens) throw new Error('Not logged in to UnieAI Studio.')
    const updated: UnieAITokens = { ...tokens, activeOrgId: orgId }
    const result = saveUnieAITokens(updated)
    if (!result.success) {
      throw new Error(result.warning ?? 'Failed to update active organization')
    }
    return updated
  }

  async logout(): Promise<boolean> {
    const tokens = getUnieAITokens()
    // Delete this device session's runtime key first while the access token is
    // still valid — uses Studio's existing /api/user-api-keys/:id endpoint, the
    // same one the Keys page UI uses, so the "[SSTA-FEWY]" entry disappears on
    // logout instead of piling up as a disabled row. Best-effort: failures
    // (network, expired token, already deleted) never block the revoke below.
    if (tokens?.accessToken) {
      let keyId = tokens.gatewayKeyId
      // Fallback for sessions that logged in before gatewayKeyId capture
      // landed: pull the linked key id from /api/config now, while we still
      // have a valid access token. If Studio doesn't expose apiKeyId yet
      // (older deploy) we just skip the delete and fall through to revoke.
      if (!keyId && tokens.activeOrgId) {
        try {
          const config = await fetchConfig(
            tokens.studioUrl,
            tokens.accessToken,
            tokens.activeOrgId,
          )
          const opts = (
            config?.provider?.unieai as
              | { options?: { apiKeyId?: string } }
              | undefined
          )?.options
          keyId = opts?.apiKeyId
        } catch {
          // best-effort
        }
      }
      if (keyId) {
        await deleteSessionRuntimeKey(
          tokens.studioUrl,
          tokens.accessToken,
          keyId,
        )
      }
    }
    if (tokens?.refreshToken) {
      try {
        await revokeRefreshToken(tokens.studioUrl, tokens.refreshToken)
      } catch {
        // revoke is best-effort; we still delete local credentials
      }
    }
    return deleteUnieAITokens()
  }
}

function absoluteVerificationUri(
  studioUrl: string,
  device: UnieAIDeviceAuthResponse,
): string {
  const target = device.verification_uri_complete
  if (/^https?:\/\//i.test(target)) return target
  const path = target.startsWith('/') ? target : `/${target}`
  return `${studioUrl}${path}`
}

async function pollUntilFinal(
  studioUrl: string,
  device: UnieAIDeviceAuthResponse,
  signal?: AbortSignal,
  gatewayUrl?: string,
): Promise<DevicePollResult> {
  let intervalMs = Math.max(device.interval, 1) * 1000
  const deadline = Date.now() + device.expires_in * 1000

  while (Date.now() < deadline) {
    if (signal?.aborted) return { kind: 'error', message: 'Login cancelled.' }

    await sleep(intervalMs, signal)

    const result = await exchangeDeviceCode(studioUrl, device.device_code)
    switch (result.kind) {
      case 'success': {
        const tokens = await persistInitialTokens(studioUrl, result.tokens, gatewayUrl)
        return { kind: 'success', tokens }
      }
      case 'pending':
        continue
      case 'slow_down':
        intervalMs += 5_000
        continue
      case 'expired':
        return { kind: 'expired' }
      case 'denied':
        return { kind: 'denied' }
      case 'error':
        return {
          kind: 'error',
          message: result.description
            ? `${result.error}: ${result.description}`
            : result.error,
        }
    }
  }

  return { kind: 'expired' }
}

async function persistInitialTokens(
  studioUrl: string,
  response: { access_token: string; refresh_token: string; expires_in: number },
  gatewayUrl?: string,
): Promise<UnieAITokens> {
  let user: UnieAIUser | undefined
  let orgs: UnieAIOrg[] = []
  try {
    user = await fetchUser(studioUrl, response.access_token)
  } catch {
    // user fetch is informational; ignore failure
  }
  try {
    orgs = await fetchOrgs(studioUrl, response.access_token)
  } catch {
    // orgs fetch is informational at login time
  }

  const trimmedGateway = gatewayUrl?.trim()
  const tokens: UnieAITokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: Date.now() + response.expires_in * 1000,
    studioUrl,
    accountId: user?.id,
    email: user?.email,
    activeOrgId: orgs[0]?.id,
    ...(trimmedGateway
      ? {
          gatewayBaseURL: normalizeGatewayUrl(trimmedGateway),
          gatewayBaseURLLocked: true,
        }
      : {}),
  }
  const result = saveUnieAITokens(tokens)
  if (!result.success) {
    throw new Error(result.warning ?? 'Failed to persist UnieAI Studio tokens')
  }
  return tokens
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function ensureFreshUnieAITokens(): Promise<UnieAITokens | null> {
  const service = new UnieAIAuthService()
  try {
    return await service.ensureFreshTokens()
  } catch {
    return null
  }
}

/**
 * Fetch the Studio config and write the resulting model list into globalConfig
 * so `/model` (and any code reading additionalModelOptionsCache) sees them
 * synchronously. Best-effort; failures are swallowed.
 */
export async function syncUnieAIModelsToCache(): Promise<number> {
  try {
    const { saveGlobalConfig } = await import('../../utils/config.js')
    const service = new UnieAIAuthService()
    const config = await service.getConfig()
    const providerConfig = config?.provider?.unieai
    const modelMap = providerConfig?.models ?? {}
    // Show which Studio deployment a model comes from in the `/model` picker, so
    // users on private/on-prem Studios (e.g. studio.demo.unieai.com) can tell at
    // a glance they aren't pointed at the public cloud. The public cloud
    // (studio.unieai.com) is the default, so we keep its label bare ("UnieAI
    // Studio") and only append the URL for non-default deployments.
    const studioUrl = getUnieAITokens()?.studioUrl
    const isPublicCloud =
      !studioUrl || normalizeStudioUrl(studioUrl) === DEFAULT_STUDIO_URL
    const studioLabel = isPublicCloud
      ? 'UnieAI Studio'
      : `UnieAI Studio (${studioUrl})`
    const options: Array<{ value: string; label: string; description: string }> = []
    const ids: string[] = []
    for (const [id, info] of Object.entries(modelMap)) {
      const name =
        (info && typeof info === 'object' && 'name' in info && typeof (info as { name?: unknown }).name === 'string'
          ? (info as { name: string }).name
          : '') || id
      ids.push(id)
      options.push({
        value: id,
        label: name,
        description: `${studioLabel} · ${id}`,
      })
    }
    saveGlobalConfig((current) => ({
      ...current,
      unieaiModelOptionsCache: options as unknown as typeof current.unieaiModelOptionsCache,
    }))

    // If the user's currently-selected model isn't a Studio model, point them at
    // the first one in the list so the next request routes through the UnieAI
    // gateway instead of failing against Anthropic. They can still pick a
    // different one with `/model`.
    if (ids.length > 0) {
      try {
        const settingsMod = await import('../../utils/settings/settings.js')
        const current = settingsMod.getSettingsForSource('userSettings') ?? {}
        const currentModel = (current as { model?: string }).model
        if (!currentModel || !ids.includes(currentModel)) {
          settingsMod.updateSettingsForSource('userSettings', {
            ...current,
            model: ids[0],
          })
        }
      } catch {
        // settings sync is best-effort
      }
    }

    // Stash the gateway credentials so the inference fetch hook can use them
    // without an extra /api/config round-trip per request.
    const options_raw = (providerConfig as { options?: { apiKey?: string; apiKeyId?: string; baseURL?: string } } | undefined)?.options
    const apiKey = options_raw?.apiKey ?? (providerConfig as { apiKey?: string } | undefined)?.apiKey
    const apiKeyId = options_raw?.apiKeyId ?? (providerConfig as { apiKeyId?: string } | undefined)?.apiKeyId
    const baseURL = options_raw?.baseURL ?? (providerConfig as { baseURL?: string } | undefined)?.baseURL
    const tokens = getUnieAITokens()
    if (tokens && apiKey) {
      // Keep an explicit user-typed gateway (company/地端 login) intact;
      // otherwise resolve via env override -> public config baseURL -> derive
      // from the Studio host. Never silently force the public cloud gateway.
      const gatewayBaseURL = resolveGatewayBaseURL({
        studioUrl: tokens.studioUrl,
        userGatewayUrl: tokens.gatewayBaseURLLocked ? tokens.gatewayBaseURL : undefined,
        configBaseURL: baseURL,
      })
      saveUnieAITokens({
        ...tokens,
        gatewayApiKey: apiKey,
        gatewayBaseURL,
        ...(apiKeyId ? { gatewayKeyId: apiKeyId } : {}),
        availableModelIds: ids,
      })
    }
    return options.length
  } catch {
    return 0
  }
}
