/**
 * Self-contained auto-updater for the standalone (bun `--compile`) binary.
 *
 * The upstream native installer (installer.ts + download.ts) is built for
 * Anthropic's distribution layout: versioned directories, symlinks in
 * ~/.local/bin, and a GCS bucket of official Claude Code binaries. That does two
 * wrong things for this fork:
 *   1. it points version checks + downloads at Anthropic's GCS bucket, and
 *   2. it would silently replace UnieAI Code with upstream Claude Code.
 *
 * Our standalone binary is shipped by install.sh as a SINGLE file at
 * ~/.local/bin/unieai, downloaded from the public distribution repo
 * `UnieAI/Unieai-Code-Publish` GitHub Releases (tags `cli-v*`, assets named
 * `unieai-<os>-<arch>` — see scripts/build/compile.ts). This updater mirrors
 * install.sh exactly: resolve the newest `cli-v*` release, download the matching
 * asset, and atomically replace the running executable in place.
 */
import axios from 'axios'
import { chmod, rename, writeFile } from 'fs/promises'
import { logForDebugging } from '../debug.js'
import { gt } from '../semver.js'

// Public distribution repo — the source repo is private, so releases + the
// installer live here. Keep in sync with install.sh's REPO.
const PUBLISH_REPO = 'UnieAI/Unieai-Code-Publish'
const RELEASES_API = `https://api.github.com/repos/${PUBLISH_REPO}/releases?per_page=100`
const CLI_TAG_PREFIX = 'cli-v'

export type GitHubInstallResult = {
  latestVersion: string | null
  wasUpdated: boolean
  // Present for shape-compatibility with the native InstallLatestResult so the
  // same call sites (NativeAutoUpdater, cli/update) can consume either.
  lockFailed?: boolean
  lockHolderPid?: number
}

/**
 * Release-asset name for the current platform. Must match the output names in
 * scripts/build/compile.ts and the os/arch mapping in install.sh.
 */
export function getReleaseAssetName(): string {
  const os =
    process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const base = `unieai-${os}-${arch}`
  return process.platform === 'win32' ? `${base}.exe` : base
}

/**
 * Newest `cli-v*` version published to the distribution repo, or null on any
 * failure (offline, rate-limited, none published). `stable` excludes GitHub
 * pre-releases; `latest` includes them.
 */
export async function getLatestVersionFromGitHub(
  channel: string,
): Promise<string | null> {
  try {
    const response = await axios.get(RELEASES_API, {
      timeout: 5000,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'unieai-code',
      },
    })
    const releases: unknown = response.data
    if (!Array.isArray(releases)) return null

    let latest: string | null = null
    for (const release of releases) {
      const tag = (release as { tag_name?: unknown }).tag_name
      if (typeof tag !== 'string' || !tag.startsWith(CLI_TAG_PREFIX)) continue
      if (channel === 'stable' && (release as { prerelease?: boolean }).prerelease)
        continue
      const version = tag.slice(CLI_TAG_PREFIX.length)
      if (!latest || gt(version, latest)) latest = version
    }
    return latest
  } catch (error) {
    logForDebugging(`Failed to resolve latest release from GitHub: ${error}`)
    return null
  }
}

/**
 * Check for and, if newer, download + install the latest standalone binary from
 * the distribution repo's GitHub Releases, replacing the running executable.
 * Returns { wasUpdated: false } when already up to date. Throws on download /
 * filesystem errors so callers can surface an "update failed" state.
 */
export async function installLatestFromGitHub(
  channel: string,
): Promise<GitHubInstallResult> {
  const latestVersion = await getLatestVersionFromGitHub(channel)
  if (!latestVersion) {
    return { latestVersion: null, wasUpdated: false }
  }
  if (!gt(latestVersion, MACRO.VERSION)) {
    // Already current (or ahead, e.g. a local dev build). Report the resolved
    // version so callers can display "up to date".
    return { latestVersion, wasUpdated: false }
  }

  const asset = getReleaseAssetName()
  const url = `https://github.com/${PUBLISH_REPO}/releases/download/${CLI_TAG_PREFIX}${latestVersion}/${asset}`
  const targetPath = process.execPath

  logForDebugging(
    `githubUpdater: downloading ${asset} @ ${latestVersion} -> ${targetPath}`,
  )
  const download = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120_000,
    maxRedirects: 5,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  })
  const buffer = Buffer.from(download.data as ArrayBuffer)

  if (process.platform === 'win32') {
    // Windows won't let us overwrite a running .exe, but it will let us rename
    // it. Move the current binary aside, then drop the new one in its place;
    // the stale `.old-*` file is cleaned up opportunistically on a later run.
    const stalePath = `${targetPath}.old-${process.pid}`
    await rename(targetPath, stalePath).catch(() => {})
    await writeFile(targetPath, buffer)
  } else {
    // Write next to the target (same filesystem) so the rename is atomic and
    // never crosses devices, then swap it over the running binary — the open
    // inode keeps the current process alive until it restarts.
    const tmpPath = `${targetPath}.download-${process.pid}`
    await writeFile(tmpPath, buffer)
    await chmod(tmpPath, 0o755)
    await rename(tmpPath, targetPath)
  }

  return { latestVersion, wasUpdated: true }
}
