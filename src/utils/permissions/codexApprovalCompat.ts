/**
 * Codex-vocabulary compatibility layer.
 *
 * codex CLI expresses execution policy with `approval_policy` and
 * `sandbox_mode`. cc-haha already has equivalent engines (PermissionMode +
 * the sandbox adapter), just under different names. These pure functions map
 * codex's vocabulary onto cc-haha's existing knobs so a user can configure
 * with the mental model they know. The mapping is intentionally approximate
 * (codex's "ask only on failure" has no exact PermissionMode); see comments.
 *
 * Precedence: these are only consulted as a fallback when the native cc-haha
 * setting (permissions.defaultMode / sandbox.enabled) is unset — the native
 * setting always wins.
 */

import type { PermissionMode } from '../../types/permissions.js'

export const CODEX_APPROVAL_POLICIES = [
  'untrusted',
  'on-request',
  'on-failure',
  'never',
] as const
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number]

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number]

/**
 * Map a codex `approval_policy` to a cc-haha PermissionMode.
 *
 * - untrusted / on-request → 'default' (prompt before privileged actions)
 * - on-failure             → 'acceptEdits' (proceed; sandbox guards bash, only
 *                             surfaces problems — closest to "ask on failure")
 * - never                  → 'bypassPermissions' (never prompt)
 *
 * Returns undefined for an unrecognized value so callers can fall through.
 */
export function approvalPolicyToPermissionMode(
  policy: string | null | undefined,
): PermissionMode | undefined {
  switch (policy) {
    case 'untrusted':
    case 'on-request':
      return 'default'
    case 'on-failure':
      return 'acceptEdits'
    case 'never':
      return 'bypassPermissions'
    default:
      return undefined
  }
}

/**
 * Map a codex `sandbox_mode` to cc-haha's sandbox.enabled boolean.
 *
 * - read-only / workspace-write → true  (run commands inside the sandbox)
 * - danger-full-access          → false (no sandbox)
 *
 * Returns undefined for an unrecognized value so callers can fall through.
 */
export function sandboxModeToSandboxEnabled(
  mode: string | null | undefined,
): boolean | undefined {
  switch (mode) {
    case 'read-only':
    case 'workspace-write':
      return true
    case 'danger-full-access':
      return false
    default:
      return undefined
  }
}
