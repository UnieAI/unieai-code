import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { summarizeProcesses, type ProcessSnapshot } from "./backgroundProcesses.cjs"
import { parseCliVersion, updateNotice, type VersionInfo } from "./versionCompare.cjs"

/**
 * Status bar surfaces for the extension.
 *
 * The update indicator deliberately does NOT poll a registry. The CLI already
 * runs an update check on a 20-hour cadence and caches the result in
 * `$UNIEAI_HOME/version.json`; the extension reads that file. One checker, two
 * surfaces — a second poller would double the network traffic and let the two
 * disagree about what the latest version is.
 */

const VERSION_FILENAME = "version.json"

/** How often to re-read the cache. The CLI refreshes it far less often. */
const REFRESH_MS = 15 * 60 * 1000

export type StatusBarDeps = {
  /** Directory holding version.json — injected so it can be pointed at a fixture. */
  home: string
  /** Resolves the running CLI's version string, or null if it cannot be read. */
  currentVersion: () => Promise<string | null>
}

/** Read the CLI's cached update info, tolerating absence and corruption. */
export function readVersionInfo(home: string): VersionInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, VERSION_FILENAME), "utf8")) as VersionInfo
  } catch {
    // No check has run yet, or the file is mid-write. Either way there is
    // nothing to show, and an exception here would break activation.
    return null
  }
}

export class UpdateStatusBarItem {
  private readonly item: vscode.StatusBarItem
  private timer: NodeJS.Timeout | undefined
  private cachedVersion: string | null | undefined

  constructor(private readonly deps: StatusBarDeps) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.name = "UnieAI Code Update"
    this.item.command = "unieai-code.showUpdateInfo"
  }

  /** Begin showing the indicator and keep it current. */
  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
  }

  async refresh(): Promise<void> {
    // The CLI version cannot change while the window is open, so resolve it once.
    if (this.cachedVersion === undefined) {
      this.cachedVersion = await this.deps.currentVersion()
    }
    const notice = updateNotice(readVersionInfo(this.deps.home), this.cachedVersion)
    if (!notice) {
      this.item.hide()
      return
    }
    this.item.text = `$(cloud-download) UnieAI ${notice.latest}`
    this.item.tooltip = `UnieAI Code ${notice.latest} is available (you have ${this.cachedVersion}). Click for how to update.`
    this.item.show()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.item.dispose()
  }
}

/**
 * Status bar entry for the delegated vision model.
 *
 * Shown only once a model is chosen: an empty slot would be noise for the many
 * sessions that never look at an image.
 */
export class VisionStatusBarItem {
  private readonly item: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
    this.item.name = "UnieAI Code Vision Model"
    this.item.command = "unieai-code.selectVisionModel"
  }

  set(model: string | null): void {
    if (!model) {
      this.item.hide()
      return
    }
    this.item.text = `$(eye) ${model}`
    this.item.tooltip = `Images are read by ${model}. Click to change or re-verify.`
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
  }
}

/**
 * How often to recount background processes.
 *
 * Polled rather than driven by events because nothing tells the host when a
 * background job EXITS — the manager only ever reports a start, and a dev server
 * that crashed on its own would otherwise leave the badge claiming it is still
 * up. Cheap enough to do on a short cadence: it walks a handful of in-memory
 * records and touches no disk or network.
 */
const PROCESS_REFRESH_MS = 3000

export type BackgroundProcessDeps = {
  /** Snapshots from every live process manager — injected so it can be faked. */
  list: () => ProcessSnapshot[]
}

/**
 * Status bar entry for background processes (run_background).
 *
 * Hidden whenever nothing is running, like the vision entry: the great majority
 * of sessions never start a background job, and a permanent "0" would be noise
 * in the one place the user looks to find out that something IS happening.
 */
export class BackgroundProcessStatusBarItem {
  private readonly item: vscode.StatusBarItem
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly deps: BackgroundProcessDeps) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98)
    this.item.name = "UnieAI Code Background Processes"
    this.item.command = "unieai-code.showBackgroundProcesses"
  }

  /** Begin showing the indicator and keep it current. */
  start(): void {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), PROCESS_REFRESH_MS)
  }

  refresh(): void {
    let summary: ReturnType<typeof summarizeProcesses> = null
    try {
      summary = summarizeProcesses(this.deps.list())
    } catch {
      // The engine may not be loaded yet, or may have been torn down. Neither is
      // worth an error notification over a status bar count.
      summary = null
    }
    if (!summary) {
      this.item.hide()
      return
    }
    this.item.text = summary.text
    this.item.tooltip = summary.tooltip
    this.item.show()
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
    }
    this.item.dispose()
  }
}
