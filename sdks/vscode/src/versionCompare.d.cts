/** Cache written by the CLI's update check ($UNIEAI_HOME/version.json). */
export type VersionInfo = {
  latest_version?: string
  last_checked_at?: string
  dismissed_version?: string | null
}

export function isNewer(
  latest: string | null | undefined,
  current: string | null | undefined,
): boolean | null

export function updateNotice(
  versionInfo: VersionInfo | null | undefined,
  currentVersion: string | null | undefined,
): { latest: string } | null

export function parseCliVersion(output: string | null | undefined): string | null
