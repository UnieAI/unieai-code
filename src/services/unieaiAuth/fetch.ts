import type {
  UnieAIDeviceAuthResponse,
  UnieAIOrg,
  UnieAIRemoteConfig,
  UnieAITokenError,
  UnieAITokenResponse,
  UnieAIUser,
} from './types.js'

export const UNIEAI_CLIENT_ID = 'opencode-cli'
export const UNIEAI_DEVICE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code'

export const DEFAULT_STUDIO_URL = 'https://studio.unieai.com'

// Public cloud inference gateway. Used only as the last-resort default when we
// can't derive an enterprise/on-prem gateway from the Studio URL or config.
export const DEFAULT_GATEWAY_BASE_URL = 'https://api.unieai.com/v1'

export function normalizeStudioUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return trimmed
}

export function resolveStudioUrl(override?: string): string {
  const candidate = override || process.env.UNIEAI_STUDIO_URL || DEFAULT_STUDIO_URL
  return normalizeStudioUrl(candidate)
}

// Normalize a user/env supplied gateway URL: add https:// if scheme-less and
// strip trailing slashes. The path (e.g. /v1) is preserved as given.
export function normalizeGatewayUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`
  }
  return trimmed
}

// Derive an inference gateway from the Studio host by swapping the leading
// `studio.` label for `api.`. Covers both cloud (studio.unieai.com ->
// api.unieai.com) and on-prem (studio.demo.unieai.com -> api.demo.unieai.com)
// without hardcoding a single host. Falls back to the public cloud gateway if
// the Studio URL can't be parsed.
export function deriveGatewayFromStudio(studioUrl: string): string {
  try {
    const u = new URL(normalizeGatewayUrl(studioUrl))
    const host = u.hostname.startsWith('studio.')
      ? `api.${u.hostname.slice('studio.'.length)}`
      : u.hostname
    const port = u.port ? `:${u.port}` : ''
    return `${u.protocol}//${host}${port}/v1`
  } catch {
    return DEFAULT_GATEWAY_BASE_URL
  }
}

// Resolve the inference gateway base URL with a clear precedence so on-prem
// (地端) enterprise deployments stop falling back to the public cloud gateway:
//   1. UNIEAI_GATEWAY_URL env var — operator escape hatch, fixes already
//      logged-in sessions without re-login.
//   2. A gateway URL the user typed at company login (userGatewayUrl).
//   3. A publicly reachable baseURL from Studio /api/config (internal
//      runtime:/localhost/127.* URLs are rejected — they aren't reachable from
//      the user's machine).
//   4. Derived from the Studio host (studio.* -> api.*).
export function resolveGatewayBaseURL(opts: {
  studioUrl: string
  userGatewayUrl?: string
  configBaseURL?: string
}): string {
  const env = process.env.UNIEAI_GATEWAY_URL?.trim()
  if (env) return normalizeGatewayUrl(env)

  if (opts.userGatewayUrl && opts.userGatewayUrl.trim()) {
    return normalizeGatewayUrl(opts.userGatewayUrl)
  }

  if (
    opts.configBaseURL &&
    /^https?:\/\/(?!runtime:|localhost|127\.)/i.test(opts.configBaseURL)
  ) {
    return normalizeGatewayUrl(opts.configBaseURL)
  }

  return deriveGatewayFromStudio(opts.studioUrl)
}

async function jsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `${label} failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    )
  }
  return (await res.json()) as T
}

export async function requestDeviceCode(
  studioUrl: string,
): Promise<UnieAIDeviceAuthResponse> {
  const res = await fetch(`${studioUrl}/auth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: UNIEAI_CLIENT_ID }),
  })
  return jsonOrThrow<UnieAIDeviceAuthResponse>(res, 'device code request')
}

export type ExchangeDeviceCodeResult =
  | { kind: 'success'; tokens: UnieAITokenResponse }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error'; error: string; description?: string }

export async function exchangeDeviceCode(
  studioUrl: string,
  deviceCode: string,
): Promise<ExchangeDeviceCodeResult> {
  const res = await fetch(`${studioUrl}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: UNIEAI_DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: UNIEAI_CLIENT_ID,
    }),
  })

  if (res.ok) {
    const tokens = (await res.json()) as UnieAITokenResponse
    return { kind: 'success', tokens }
  }

  const body = (await res.json().catch(() => null)) as UnieAITokenError | null
  const error = body?.error || `http_${res.status}`
  switch (error) {
    case 'authorization_pending':
      return { kind: 'pending' }
    case 'slow_down':
      return { kind: 'slow_down' }
    case 'expired_token':
      return { kind: 'expired' }
    case 'access_denied':
      return { kind: 'denied' }
    default:
      return { kind: 'error', error, description: body?.error_description }
  }
}

export async function refreshAccessToken(
  studioUrl: string,
  refreshToken: string,
): Promise<UnieAITokenResponse> {
  const res = await fetch(`${studioUrl}/auth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: UNIEAI_CLIENT_ID,
    }),
  })
  return jsonOrThrow<UnieAITokenResponse>(res, 'token refresh')
}

// Best-effort: delete this device session's runtime key (the row visible on the
// Studio Keys page) via the same endpoint the Keys UI uses. Called before
// revokeRefreshToken so the device access token is still valid. Returns true on
// 2xx/404 (already gone), false on other errors — caller continues with revoke
// regardless so logout never blocks on this.
export async function deleteSessionRuntimeKey(
  studioUrl: string,
  accessToken: string,
  keyId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${studioUrl}/api/user-api-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

export async function revokeRefreshToken(
  studioUrl: string,
  refreshToken: string,
): Promise<void> {
  const res = await fetch(`${studioUrl}/auth/device/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: UNIEAI_CLIENT_ID,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `token revoke failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`,
    )
  }
}

function authHeaders(accessToken: string, extra?: Record<string, string>): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...(extra ?? {}),
  }
}

export async function fetchUser(
  studioUrl: string,
  accessToken: string,
): Promise<UnieAIUser> {
  const res = await fetch(`${studioUrl}/api/user`, {
    headers: authHeaders(accessToken),
  })
  return jsonOrThrow<UnieAIUser>(res, 'fetch user')
}

export async function fetchOrgs(
  studioUrl: string,
  accessToken: string,
): Promise<UnieAIOrg[]> {
  const res = await fetch(`${studioUrl}/api/orgs`, {
    headers: authHeaders(accessToken),
  })
  return jsonOrThrow<UnieAIOrg[]>(res, 'fetch orgs')
}

export async function fetchConfig(
  studioUrl: string,
  accessToken: string,
  orgId: string,
): Promise<UnieAIRemoteConfig | null> {
  const res = await fetch(`${studioUrl}/api/config`, {
    headers: authHeaders(accessToken, { 'x-org-id': orgId }),
  })
  if (res.status === 404) return null
  const body = await jsonOrThrow<{ config: UnieAIRemoteConfig }>(res, 'fetch config')
  return body.config ?? null
}
