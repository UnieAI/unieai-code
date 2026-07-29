/**
 * versionCompare.cjs — decide whether a released version is newer than this build.
 *
 * Mirrors the CLI's rule (`codex-rs/tui/src/update_versions.rs`) on purpose: the
 * extension reads the very cache the CLI writes, so the two must agree on what
 * "newer" means or the status bar would contradict the CLI's own banner.
 *
 * The two sides are parsed differently. A released version is expected to be
 * clean semver, and a pre-release there fails to parse so it never prompts. The
 * running build is parsed leniently because an unstamped build carries an
 * internal id (`0.0.19-dev-uc0.5.0-ac0.4.0`) that strict parsing rejects — which
 * would make every dev build report "up to date" forever.
 *
 * Plain CommonJS with a sibling `.d.cts` so it is unit-testable under
 * `node --test`; the extension has no TypeScript-aware test runner.
 */

/** Strict `MAJOR.MINOR.PATCH`; anything else (including a pre-release) is null. */
function parseRelease(version) {
  const parts = String(version ?? "").trim().split(".")
  if (parts.length < 3) return null
  const nums = parts.slice(0, 3).map((p) => (/^\d+$/.test(p) ? Number(p) : null))
  return nums.some((n) => n === null) ? null : nums
}

/** Lenient: drop an internal build id before parsing. */
function parseBuild(version) {
  const trimmed = String(version ?? "").trim()
  const dash = trimmed.indexOf("-")
  return parseRelease(dash === -1 ? trimmed : trimmed.slice(0, dash))
}

/**
 * Is `latest` newer than `current`?
 *
 * Returns null when either side cannot be read, so callers can stay silent
 * rather than guess — showing a wrong update prompt is worse than showing none.
 */
function isNewer(latest, current) {
  const l = parseRelease(latest)
  const c = parseBuild(current)
  if (!l || !c) return null
  for (let i = 0; i < 3; i += 1) {
    if (l[i] !== c[i]) return l[i] > c[i]
  }
  return false
}

/**
 * Decide what the status bar should say, given the CLI's cache file contents.
 *
 * `dismissed_version` is honoured so dismissing in the CLI also quiets the
 * extension — one decision, both surfaces.
 */
function updateNotice(versionInfo, currentVersion) {
  const latest = versionInfo?.latest_version
  if (!latest) return null
  if (versionInfo?.dismissed_version && versionInfo.dismissed_version === latest) return null
  return isNewer(latest, currentVersion) === true ? { latest } : null
}

/** Pull a version out of `unieai --version` output, which may carry extra words. */
function parseCliVersion(output) {
  const match = String(output ?? "").match(/\d+\.\d+\.\d+[^\s]*/)
  return match ? match[0] : null
}

module.exports = { isNewer, updateNotice, parseCliVersion }
