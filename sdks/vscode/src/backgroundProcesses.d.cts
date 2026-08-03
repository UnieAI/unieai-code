/**
 * One row from a process manager's `list()` (agent-runtime/src/process-manager.mjs).
 * Only the fields the UI reads are declared; the snapshot carries more.
 */
export type ProcessSnapshot = {
  id: string
  command: string
  pid: number | null
  status: string
  exitCode: number | null
  signal: string | null
  uptimeMs: number
  outputLines: number
  droppedLines: number
}

/** What the status bar shows, or null when it should hide. */
export type ProcessSummary = {
  running: number
  text: string
  tooltip: string
}

export function isRunning(process: ProcessSnapshot | null | undefined): boolean

export function describeLifetime(process: ProcessSnapshot | null | undefined): string

export function describeProcess(process: ProcessSnapshot | null | undefined): string

export function summarizeProcesses(
  processes: ProcessSnapshot[] | null | undefined,
): ProcessSummary | null
