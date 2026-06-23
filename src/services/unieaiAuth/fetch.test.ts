import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_GATEWAY_BASE_URL,
  deriveGatewayFromStudio,
  normalizeGatewayUrl,
  resolveGatewayBaseURL,
} from './fetch.js'

const ENV_KEY = 'UNIEAI_GATEWAY_URL'

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('normalizeGatewayUrl', () => {
  test('adds https:// when scheme-less and strips trailing slashes', () => {
    expect(normalizeGatewayUrl('api.demo.unieai.com/v1/')).toBe(
      'https://api.demo.unieai.com/v1',
    )
  })

  test('keeps an explicit http scheme and path', () => {
    expect(normalizeGatewayUrl('http://10.0.0.5:8080/v1//')).toBe(
      'http://10.0.0.5:8080/v1',
    )
  })
})

describe('deriveGatewayFromStudio', () => {
  test('cloud studio derives the public cloud gateway', () => {
    expect(deriveGatewayFromStudio('https://studio.unieai.com')).toBe(
      'https://api.unieai.com/v1',
    )
  })

  test('on-prem studio swaps studio. -> api. and keeps the rest', () => {
    expect(deriveGatewayFromStudio('https://studio.demo.unieai.com')).toBe(
      'https://api.demo.unieai.com/v1',
    )
  })

  test('non-studio host is preserved (port kept)', () => {
    expect(deriveGatewayFromStudio('http://gateway.internal:9000')).toBe(
      'http://gateway.internal:9000/v1',
    )
  })
})

describe('resolveGatewayBaseURL', () => {
  test('env override wins over everything', () => {
    process.env[ENV_KEY] = 'https://env.example.com/v1'
    expect(
      resolveGatewayBaseURL({
        studioUrl: 'https://studio.demo.unieai.com',
        userGatewayUrl: 'https://typed.example.com/v1',
        configBaseURL: 'https://config.example.com/v1',
      }),
    ).toBe('https://env.example.com/v1')
  })

  test('user-typed gateway beats config and derivation', () => {
    expect(
      resolveGatewayBaseURL({
        studioUrl: 'https://studio.demo.unieai.com',
        userGatewayUrl: 'gateway.acme.internal/v1',
        configBaseURL: 'https://config.example.com/v1',
      }),
    ).toBe('https://gateway.acme.internal/v1')
  })

  test('public config baseURL is used when no user/env value', () => {
    expect(
      resolveGatewayBaseURL({
        studioUrl: 'https://studio.demo.unieai.com',
        configBaseURL: 'https://gw.demo.unieai.com/v1',
      }),
    ).toBe('https://gw.demo.unieai.com/v1')
  })

  test('internal runtime/localhost config URLs are rejected; derive instead', () => {
    expect(
      resolveGatewayBaseURL({
        studioUrl: 'https://studio.demo.unieai.com',
        configBaseURL: 'http://runtime:8080/v1',
      }),
    ).toBe('https://api.demo.unieai.com/v1')
  })

  test('cloud login with no hints falls back to the public cloud gateway', () => {
    expect(
      resolveGatewayBaseURL({ studioUrl: 'https://studio.unieai.com' }),
    ).toBe(DEFAULT_GATEWAY_BASE_URL)
  })
})
