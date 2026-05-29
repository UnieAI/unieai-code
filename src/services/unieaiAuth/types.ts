export type UnieAIDeviceAuthResponse = {
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export type UnieAITokenResponse = {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
}

export type UnieAITokenError = {
  error:
    | 'authorization_pending'
    | 'slow_down'
    | 'expired_token'
    | 'access_denied'
    | string
  error_description?: string
}

export type UnieAIUser = {
  id: string
  email: string
}

export type UnieAIOrg = {
  id: string
  name?: string
  slug?: string
}

export type UnieAIModelInfo = {
  id: string
  name?: string
  contextWindow?: number
  description?: string
} & Record<string, unknown>

export type UnieAIProviderConfig = {
  baseURL?: string
  apiKey?: string
  models?: Record<string, UnieAIModelInfo>
} & Record<string, unknown>

export type UnieAIRemoteConfig = {
  provider?: {
    unieai?: UnieAIProviderConfig
  } & Record<string, unknown>
} & Record<string, unknown>

export type UnieAITokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  studioUrl: string
  accountId?: string
  email?: string
  activeOrgId?: string
  // Cached gateway credentials from Studio /api/config — refreshed on `unieai login`
  // and `unieai models`. Used by the inference fetch hook so request-time has no
  // extra round trip. Not security-sensitive beyond the OAuth token itself.
  gatewayBaseURL?: string
  gatewayApiKey?: string
  // user_api_keys row id for the runtime key this session is tied to. Stored
  // so logout can DELETE its own device-session key (the "[SSTA-FEWY]" entry)
  // via Studio's /api/user-api-keys/:id, instead of leaving it as a disabled
  // row in the user's Keys page.
  gatewayKeyId?: string
  availableModelIds?: string[]
}
