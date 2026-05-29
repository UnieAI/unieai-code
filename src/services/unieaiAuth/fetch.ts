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
