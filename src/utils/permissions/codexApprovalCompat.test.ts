import { describe, expect, test } from 'bun:test'
import {
  approvalPolicyToPermissionMode,
  sandboxModeToSandboxEnabled,
} from './codexApprovalCompat.js'

describe('approvalPolicyToPermissionMode', () => {
  test('untrusted/on-request → default', () => {
    expect(approvalPolicyToPermissionMode('untrusted')).toBe('default')
    expect(approvalPolicyToPermissionMode('on-request')).toBe('default')
  })

  test('on-failure → acceptEdits', () => {
    expect(approvalPolicyToPermissionMode('on-failure')).toBe('acceptEdits')
  })

  test('never → bypassPermissions', () => {
    expect(approvalPolicyToPermissionMode('never')).toBe('bypassPermissions')
  })

  test('unknown/empty → undefined (caller falls through)', () => {
    expect(approvalPolicyToPermissionMode('bogus')).toBeUndefined()
    expect(approvalPolicyToPermissionMode(undefined)).toBeUndefined()
    expect(approvalPolicyToPermissionMode(null)).toBeUndefined()
    expect(approvalPolicyToPermissionMode('')).toBeUndefined()
  })
})

describe('sandboxModeToSandboxEnabled', () => {
  test('read-only/workspace-write → true', () => {
    expect(sandboxModeToSandboxEnabled('read-only')).toBe(true)
    expect(sandboxModeToSandboxEnabled('workspace-write')).toBe(true)
  })

  test('danger-full-access → false', () => {
    expect(sandboxModeToSandboxEnabled('danger-full-access')).toBe(false)
  })

  test('unknown/empty → undefined (caller falls through)', () => {
    expect(sandboxModeToSandboxEnabled('bogus')).toBeUndefined()
    expect(sandboxModeToSandboxEnabled(undefined)).toBeUndefined()
    expect(sandboxModeToSandboxEnabled(null)).toBeUndefined()
  })
})
